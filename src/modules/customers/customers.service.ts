import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsNull, Repository } from 'typeorm';
import { parse } from 'csv-parse/sync';
import { Workbook } from 'exceljs';

import { Customer } from './entities/customer.entity';
import { CustomerAiProfile } from './entities/customer-ai-profile.entity';
import { CustomerVisit } from './entities/customer-visit.entity';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PendingCustomerPhoto } from './entities/pending-customer-photo.entity';
import { CustomerAttachment } from './entities/customer-attachment.entity';
import { User } from '../users/entities/user.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQuery } from './dto/list-customers.query';
import { CreateVisitDto } from './dto/create-visit.dto';
import { hashPhone } from '../../common/utils/phone-hash.util';
import { JobsService } from '../../common/jobs/jobs.service';
import { StorageService } from '../../common/storage/storage.service';
import { randomUUID } from 'crypto';
import { applyTokenSearch } from '../../common/search/token-search.util';

export interface CustomerInsights {
  customer: Customer;
  aiProfile: CustomerAiProfile | null;
  recentVisits: CustomerVisit[];
  invoiceSummary: { count: number; totalFils: number }; // populated by plan 06
  collectionSummary: { outstandingFils: number; overdueFils: number }; // plan 07
}

export interface CsvImportResult {
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

export const AI_PROFILE_REFRESH_QUEUE = 'customer-ai-profile-refresh';

/** A customer visit enriched with the visiting rep's name (per-customer history). */
export interface CustomerVisitRow {
  id: string;
  repId: string;
  repName: string | null;
  visitedAt: Date;
  hadSale: boolean;
  visitNote: string | null;
  lat: number | null;
  lng: number | null;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    @Inject(forwardRef(() => ApprovalsService))
    private readonly approvals: ApprovalsService,
    @InjectRepository(PendingCustomerPhoto)
    private readonly pendingPhotos: Repository<PendingCustomerPhoto>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(CustomerAiProfile)
    private readonly aiProfiles: Repository<CustomerAiProfile>,
    @InjectRepository(CustomerVisit)
    private readonly visits: Repository<CustomerVisit>,
    @InjectRepository(CustomerAttachment)
    private readonly attachments: Repository<CustomerAttachment>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Stage a customer document photo BEFORE the customer exists.
   *
   * The salesman photographs the registration or ID in front of the shopkeeper
   * and only then fills the form — and when the creation needs approval the
   * customer row may not exist for hours. Returns the id the create request
   * references; [claimPhoto] moves it once the customer is real.
   */
  async stagePhoto(
    file: Express.Multer.File | undefined,
    uploadedBy: string | null,
  ): Promise<PendingCustomerPhoto> {
    if (!file) throw new BadRequestException('No photo provided');
    // Images only. The generic attachment endpoint accepts PDFs and
    // spreadsheets; this one is a camera/gallery pick and anything else here is
    // a client bug worth failing loudly on.
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException(`Photo must be an image, got ${file.mimetype}`);
    }
    if (file.size > CustomersService.ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException('Photo too large (max 10 MB)');
    }
    const original = this.sanitizeFilename(file.originalname || 'photo.jpg');
    const key = `customers/_pending/${randomUUID()}-${original}`;
    const url = await this.storage.save(key, file.buffer);
    return this.pendingPhotos.save(
      this.pendingPhotos.create({
        storageKey: key,
        url,
        originalName: original,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedBy,
      }),
    );
  }

  /**
   * Create a customer on behalf of the signed-in user, applying the two rules a
   * plain [create] cannot know about:
   *
   *   a salesman must attach a document photo
   *   a salesman without canCreateCustomerDirect gets an approval request,
   *   not a customer
   *
   * Office users (no repId) are unaffected: no photo requirement, no approval.
   */
  async createAsUser(
    dto: CreateCustomerDto,
    user: AuthenticatedUser,
  ): Promise<Customer | { pendingApprovalId: string; status: 'pending' }> {
    const isSalesman = user.repId != null;
    if (!isSalesman) return this.create(dto);

    if (!dto.photoId) {
      throw new BadRequestException(
        'A customer document photo is required when a salesman creates a customer',
      );
    }
    const photo = await this.pendingPhotos.findOne({ where: { id: dto.photoId } });
    if (!photo) throw new BadRequestException('Photo not found — upload it first');
    if (photo.claimedAt) {
      throw new BadRequestException('That photo already belongs to another customer');
    }

    // Read FRESH rather than trusting the JWT claim. The office flips this
    // switch in the dashboard and expects the next customer to obey it — not
    // the next one after the salesman happens to sign out and back in, which
    // on a field phone can be days. A create already costs a photo upload and
    // several round trips; one indexed lookup does not register. A missing row
    // falls through to approval, which is the safe direction.
    const actor = await this.users.findOne({
      where: { id: user.sub },
      select: { id: true, canCreateCustomerDirect: true },
    });
    if (actor?.canCreateCustomerDirect) {
      const customer = await this.create(dto);
      await this.claimPhoto(photo, customer.id, user.sub);
      await this.claimExtraPhotos(dto.extraPhotoIds, customer.id, user.sub);
      return customer;
    }

    // No direct permission → nothing is created yet. The whole request, photo
    // included, waits for an admin. Deliberately NOT a disabled customer row:
    // a half-real customer can be sold to, and credit-checked, before anyone
    // has looked at it.
    const req = await this.approvals.createCustomerRequest(dto, user);
    return { pendingApprovalId: req.id, status: 'pending' };
  }

  /**
   * Bytes of a STAGED photo, for the reviewer looking at an approval request.
   *
   * A download endpoint rather than a public URL, matching customer attachments:
   * `storage.publicBaseUrl` is decorative here — nothing serves the storage root —
   * and a customer's commercial registration should not be fetchable by anyone
   * who guesses the filename.
   */
  async getStagedPhotoFile(
    id: string,
  ): Promise<{ photo: PendingCustomerPhoto; buffer: Buffer }> {
    const photo = await this.pendingPhotos.findOne({ where: { id } });
    if (!photo) throw new NotFoundException('Photo not found');
    return { photo, buffer: await this.storage.read(photo.storageKey) };
  }

  /** Move a staged photo onto the now-real customer. */
  async claimPhoto(
    photo: PendingCustomerPhoto,
    customerId: string,
    uploadedBy: string | null,
  ): Promise<CustomerAttachment> {
    const row = await this.attachments.save(
      this.attachments.create({
        customerId,
        storageKey: photo.storageKey,
        url: photo.url,
        originalName: photo.originalName,
        mimeType: photo.mimeType,
        sizeBytes: photo.sizeBytes,
        uploadedBy,
      }),
    );
    photo.claimedAt = new Date();
    await this.pendingPhotos.save(photo);
    return row;
  }

  /**
   * Claim EXTRA staged photos onto a now-real customer, best-effort: a missing
   * or already-claimed id is skipped rather than failing the create. The primary
   * photoId is the one that must be valid; these are the salesman's additional
   * shop images, and losing one to a race is not worth rejecting the customer.
   */
  async claimExtraPhotos(
    ids: string[] | undefined,
    customerId: string,
    uploadedBy: string | null,
  ): Promise<void> {
    for (const id of ids ?? []) {
      if (!id) continue;
      const photo = await this.pendingPhotos.findOne({ where: { id } });
      if (!photo || photo.claimedAt) continue;
      await this.claimPhoto(photo, customerId, uploadedBy);
    }
  }

  async create(dto: CreateCustomerDto): Promise<Customer> {
    const customerNumber =
      dto.customerNumber?.trim() || (await this.nextCustomerNumber());
    const exists = await this.customers.exist({ where: { customerNumber } });
    if (exists) {
      throw new ConflictException(`Customer ${customerNumber} already exists`);
    }
    const entity = this.customers.create({
      ...dto,
      customerNumber,
      nameAr: dto.nameAr ?? dto.customerName,
      phoneHash: hashPhone(dto.phone),
      // Provenance is derived, not client-supplied: a caller that names a lead
      // IS a prospecting create, and one that does not cannot claim to be.
      source: dto.sourceProspectId ? 'PROSPECTING' : 'MANUAL',
    });
    const saved = await this.customers.save(entity);
    if (dto.sourceProspectId) {
      // An event rather than a direct call: prospecting already depends on
      // customers (convert() writes one), so calling back would be circular.
      this.events.emit('prospect.converted', {
        prospectId: dto.sourceProspectId,
        customerId: saved.id,
      });
    }
    // Tell the owning van to pull it, so a customer added from the office is
    // sellable in the field without waiting for the next home-screen refresh.
    this.events.emit('customer.changed', {
      repId: saved.repId ?? null,
      reason: 'customer.created',
    });
    // Mirror to the ERP (handled by ErpSyncService listener; no-op when ERP off).
    this.events.emit('erp.customer.created', {
      code: saved.customerNumber,
      name: saved.customerName,
      phone: saved.phone ?? null,
      email: saved.email ?? null,
      taxNumber: saved.tin ?? null,
      creditLimit: saved.creditLimit != null ? Number(saved.creditLimit) : null,
    });
    return saved;
  }

  /** Next serial customer number: CUST-000001. */
  private async nextCustomerNumber(): Promise<string> {
    const rows: Array<{ n: string }> = await this.customers.query(
      "SELECT nextval('customer_number_seq') AS n",
    );
    return `CUST-${String(rows[0]?.n ?? '0').padStart(6, '0')}`;
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    const customer = await this.findOneOrThrow(id);
    Object.assign(customer, dto);
    if (dto.phone !== undefined) {
      customer.phoneHash = hashPhone(dto.phone);
    }
    const saved = await this.customers.save(customer);
    this.events.emit('customer.changed', {
      repId: saved.repId ?? null,
      reason: 'customer.updated',
    });
    // Mirror the update to the ERP (ErpSyncService listener; no-op when ERP off).
    this.events.emit('erp.customer.updated', {
      code: saved.customerNumber,
      name: saved.customerName,
      phone: saved.phone ?? null,
      email: saved.email ?? null,
      taxNumber: saved.tin ?? null,
      creditLimit: saved.creditLimit != null ? Number(saved.creditLimit) : null,
    });
    return saved;
  }

  /**
   * Seed a customer's GPS location ONCE. Writes only while `latitude` is still
   * null, so a location-locked rep can bootstrap a store that has no pin yet but
   * can never move an established one; if an admin later clears the pin (PATCH),
   * seeding re-opens. Returns the customer (updated when it took effect).
   */
  async seedLocation(id: string, lat: number, lng: number): Promise<Customer> {
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      throw new BadRequestException('Invalid coordinates');
    }
    const res = await this.customers.update(
      { id, latitude: IsNull() },
      { latitude: lat.toFixed(6), longitude: lng.toFixed(6) },
    );
    const customer = await this.findOneOrThrow(id);
    if (res.affected) {
      // Mirror to the ERP like update() (no-op when ERP off).
      this.events.emit('erp.customer.updated', {
        code: customer.customerNumber,
        name: customer.customerName,
        phone: customer.phone ?? null,
        email: customer.email ?? null,
        taxNumber: customer.tin ?? null,
        creditLimit:
          customer.creditLimit != null ? Number(customer.creditLimit) : null,
      });
    }
    return customer;
  }

  async findOneOrThrow(id: string): Promise<Customer> {
    const c = await this.customers.findOne({ where: { id } });
    if (!c) throw new NotFoundException(`Customer ${id} not found`);
    return c;
  }

  async list(
    query: ListCustomersQuery,
    visibleRepIds: string[] | null = null,
  ): Promise<{ items: Customer[]; total: number }> {
    const qb = this.customers
      .createQueryBuilder('c')
      .where('c.deleted_at IS NULL')
      .orderBy('c.created_at', 'DESC')
      .take(query.limit ?? 25)
      .skip(query.offset ?? 0);

    if (query.unassigned) qb.andWhere('c.rep_id IS NULL');
    else if (query.repId) qb.andWhere('c.rep_id = :repId', { repId: query.repId });
    // Supervisor scope, applied on TOP of any repId filter above rather than
    // instead of it: a scoped user narrowing to one of their own salesmen must
    // still not be able to widen past their assignment by sending someone else's.
    if (visibleRepIds !== null) {
      qb.andWhere('c.rep_id IN (:...visibleRepIds)', {
        visibleRepIds: visibleRepIds.length
          ? visibleRepIds
          : ['00000000-0000-0000-0000-000000000000'],
      });
    }
    if (query.regionId) qb.andWhere('c.region_id = :regionId', { regionId: query.regionId });
    if (query.isActive !== undefined) qb.andWhere('c.is_active = :a', { a: query.isActive });

    applyTokenSearch(qb, query.q, [
      'c.name_ar',
      'c.name_en',
      'c.customer_number',
    ]);

    // Filters that require the AI profile — expressed as an EXISTS subquery so
    // getManyAndCount() doesn't try to map a joined entity (which breaks).
    if (query.segment) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM customer_ai_profile ap
                 WHERE ap.customer_id = c.id AND ap.segment = :seg)`,
        { seg: query.segment },
      );
    }
    if (query.churnRisk) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM customer_ai_profile ap
                 WHERE ap.customer_id = c.id AND ap.churn_risk_label = :cr)`,
        { cr: query.churnRisk },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async insights(id: string): Promise<CustomerInsights> {
    const customer = await this.findOneOrThrow(id);
    const [aiProfile, recentVisits] = await Promise.all([
      this.aiProfiles.findOne({ where: { customerId: id } }),
      this.visits.find({
        where: { customerId: id },
        order: { visitedAt: 'DESC' },
        take: 10,
      }),
    ]);
    return {
      customer,
      aiProfile: aiProfile ?? null,
      recentVisits,
      // Real numbers arrive with plans 06 (invoices) and 07 (collections).
      invoiceSummary: { count: 0, totalFils: 0 },
      collectionSummary: { outstandingFils: 0, overdueFils: 0 },
    };
  }

  async reassign(id: string, newRepId: string): Promise<Customer> {
    const customer = await this.findOneOrThrow(id);
    const previousRepId = customer.repId ?? null;
    customer.repId = newRepId;
    const saved = await this.customers.save(customer);
    // BOTH vans are told: the new owner to pick the customer up, the previous
    // one to let go. Signalling only the new owner leaves the old van still
    // holding — and still selling to — a customer it no longer owns.
    this.events.emit('customer.changed', {
      repId: newRepId,
      previousRepId,
      reason: 'customer.reassigned',
    });
    return saved;
  }

  /**
   * Bulk-assign customers to salesmen from an Excel upload. Each row: customer
   * NAME (column 1) + salesman number (column 2). The customer name matches on the
   * customer's name (customerName / name_ar / name_en), trimmed and
   * case-insensitive; the salesman number matches the rep code, the linked user's
   * login number, OR the van store number — whichever the office typed. A name that
   * matches more than one customer is reported as ambiguous and left untouched.
   * Rows whose customer or salesman is not found are reported back, never silently
   * dropped.
   */
  async assignSalesmenFromXlsx(buffer: Buffer): Promise<{
    total: number;
    assigned: number;
    unchanged: number;
    ambiguousCustomers: string[];
    unmatchedCustomers: string[];
    unmatchedSalesmen: string[];
  }> {
    const wb = new Workbook();
    try {
      // Pass a precisely-sized ArrayBuffer — the @types/node Buffer generic does
      // not line up with exceljs's Buffer param, and buffer.buffer may be pooled.
      const ab = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
      await wb.xlsx.load(ab);
    } catch (err) {
      throw new BadRequestException(`Malformed Excel file: ${(err as Error).message}`);
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('The Excel file has no sheets');

    // (customerName, salesmanNumber) per row. Column 1 is now a customer NAME, so
    // the header is detected from column 2 instead: a salesman number always has a
    // digit, a header label ("رقم المندوب" / "salesman number") does not, so a
    // first row whose column 2 has no digit is treated as a header and skipped.
    const pairs: Array<{ cust: string; sales: string }> = [];
    ws.eachRow((row) => {
      const cust = cellText(row.getCell(1).value);
      const sales = cellText(row.getCell(2).value);
      if (!cust && !sales) return;
      pairs.push({ cust, sales });
    });
    if (pairs.length && !/\d/.test(pairs[0].sales)) pairs.shift();
    if (pairs.length === 0) throw new BadRequestException('The file has no data rows');
    if (pairs.length > 20000) throw new BadRequestException('The file exceeds 20000 rows');

    // Salesman number → repId, matched on rep code, the linked user's number, or
    // the van store number (any of the three the office might use).
    const repRows: Array<{
      repId: string;
      code: string | null;
      userNumber: string | null;
      vanNumber: string | null;
    }> = await this.customers.manager.query(
      `SELECT r.id AS "repId", r.code AS code, u.user_number AS "userNumber", w.wh_number AS "vanNumber"
         FROM reps r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN warehouses w ON w.id = r.van_id
        WHERE r.deleted_at IS NULL`,
    );
    // Index the raw code/number/van AND a leading-zero-stripped form of numeric
    // ids, because ERP exports often zero-pad ("00008") while the rep is stored as
    // "8" (and vice-versa). First writer wins, so an exact id is never shadowed by
    // another rep's normalized form.
    const repByKey = new Map<string, string>();
    const putRep = (key: string, repId: string) => {
      if (key && !repByKey.has(key)) repByKey.set(key, repId);
    };
    for (const r of repRows) {
      for (const key of [r.code, r.userNumber, r.vanNumber]) {
        if (key == null) continue;
        const k = String(key).trim();
        if (!k) continue;
        putRep(k, r.repId);
        putRep(normSalesman(k), r.repId);
      }
    }

    // Customers indexed by normalized name, loaded once. Names are NOT unique, so
    // each normalized name maps to a list of distinct customers; a name that
    // resolves to more than one customer is ambiguous and left untouched. We index
    // all three name fields (customerName / name_ar / name_en) so the office can use
    // whichever spelling it has.
    const allCustomers = await this.customers.find({
      select: ['id', 'customerName', 'nameAr', 'nameEn', 'repId'],
    });
    const custByName = new Map<string, Array<{ id: string; repId: string | null }>>();
    const indexName = (
      name: string | null | undefined,
      rec: { id: string; repId: string | null },
    ) => {
      const key = normalizeName(name);
      if (!key) return;
      const list = custByName.get(key);
      if (!list) custByName.set(key, [rec]);
      else if (!list.some((x) => x.id === rec.id)) list.push(rec);
    };
    for (const c of allCustomers) {
      const rec = { id: c.id, repId: c.repId ?? null };
      indexName(c.customerName, rec);
      indexName(c.nameAr, rec);
      indexName(c.nameEn, rec);
    }

    const result = {
      total: pairs.length,
      assigned: 0,
      unchanged: 0,
      ambiguousCustomers: [] as string[],
      unmatchedCustomers: [] as string[],
      unmatchedSalesmen: [] as string[],
    };

    // Decide every row first (pure), then apply the assignments in one transaction.
    const toAssign: Array<{ id: string; repId: string }> = [];
    for (const { cust, sales } of pairs) {
      const matches = custByName.get(normalizeName(cust));
      if (!matches || matches.length === 0) {
        result.unmatchedCustomers.push(cust);
        continue;
      }
      if (matches.length > 1) {
        result.ambiguousCustomers.push(cust);
        continue;
      }
      const repId = repByKey.get(sales) ?? repByKey.get(normSalesman(sales));
      if (!repId) {
        result.unmatchedSalesmen.push(sales);
        continue;
      }
      const customer = matches[0];
      if (customer.repId === repId) {
        result.unchanged++;
        continue;
      }
      customer.repId = repId; // reflect the change so a repeated row counts as unchanged
      toAssign.push({ id: customer.id, repId });
      result.assigned++;
    }

    if (toAssign.length > 0) {
      await this.customers.manager.transaction(async (em) => {
        const repo = em.getRepository(Customer);
        for (const a of toAssign) await repo.update({ id: a.id }, { repId: a.repId });
      });
    }

    // Tell every affected van to re-pull its customer list (old + new owners),
    // exactly as the single-customer reassign does. Broad signal = every van.
    if (result.assigned > 0) {
      this.events.emit('customer.changed', { reason: 'bulk.salesman.assignment' });
    }
    result.ambiguousCustomers = [...new Set(result.ambiguousCustomers)];
    result.unmatchedCustomers = [...new Set(result.unmatchedCustomers)];
    result.unmatchedSalesmen = [...new Set(result.unmatchedSalesmen)];
    return result;
  }

  async addVisit(customerId: string, dto: CreateVisitDto): Promise<CustomerVisit> {
    await this.findOneOrThrow(customerId);
    return this.recordVisit({
      customerId,
      repId: dto.repId,
      visitedAt: dto.visitedAt ? new Date(dto.visitedAt) : new Date(),
      hadSale: dto.hadSale ?? false,
      visitNote: dto.visitNote ?? null,
      lat: dto.lat ?? null,
      lng: dto.lng ?? null,
    });
  }

  /**
   * Record a call on a customer — ONE row per rep per customer per day.
   *
   * A rep opens the customer (a visit with no sale), then may raise a voucher
   * (a visit with a sale). That is one doorstep, not two, so the day's row is
   * upserted rather than appended: appending would show a rep making twice the
   * calls they made, and would put the same stop in both the "sold" and "did
   * not sell" columns at once.
   *
   * Merge rules, all one-way, so replaying a call can never lose information:
   *   - hadSale latches TRUE. A sale happened that day; a later no-sale open
   *     does not un-happen it.
   *   - visitedAt keeps the EARLIEST time — when the rep actually arrived.
   *   - lat/lng and the note fill only when still empty, so the first real fix
   *     wins over a later missing one.
   */
  async recordVisit(input: {
    customerId: string;
    repId: string;
    visitedAt?: Date;
    hadSale?: boolean;
    visitNote?: string | null;
    lat?: number | null;
    lng?: number | null;
  }): Promise<CustomerVisit> {
    const visitedAt = input.visitedAt ?? new Date();
    const day = visitedAt.toISOString().slice(0, 10);

    return this.visits.manager.transaction(async (em) => {
      const repo = em.getRepository(CustomerVisit);
      const existing = await repo
        .createQueryBuilder('v')
        .setLock('pessimistic_write')
        .where('v.customer_id = :customerId', { customerId: input.customerId })
        .andWhere('v.rep_id = :repId', { repId: input.repId })
        .andWhere(`(v.visited_at AT TIME ZONE 'UTC')::date = :day::date`, { day })
        .getOne();

      if (!existing) {
        return repo.save(
          repo.create({
            customerId: input.customerId,
            repId: input.repId,
            visitedAt,
            hadSale: input.hadSale ?? false,
            visitNote: input.visitNote ?? null,
            lat: input.lat ?? null,
            lng: input.lng ?? null,
          }),
        );
      }

      existing.hadSale = existing.hadSale || (input.hadSale ?? false);
      if (visitedAt < existing.visitedAt) existing.visitedAt = visitedAt;
      existing.lat = existing.lat ?? input.lat ?? null;
      existing.lng = existing.lng ?? input.lng ?? null;
      existing.visitNote = existing.visitNote ?? input.visitNote ?? null;
      return repo.save(existing);
    });
  }

  async listVisits(
    customerId: string,
    opts: { from?: string; to?: string; limit?: number } = {},
  ): Promise<CustomerVisitRow[]> {
    await this.findOneOrThrow(customerId);
    const from = opts.from ? new Date(opts.from) : null;
    const to = opts.to ? new Date(opts.to) : null;
    const limit = opts.limit ?? 50;
    // Enrich with the visiting rep's name (who came) — the per-customer visit history.
    return (await this.visits.query(
      `
      SELECT cv.id::text                        AS id,
             cv.rep_id                          AS "repId",
             COALESCE(r.name_ar, r.name_en)     AS "repName",
             cv.visited_at                      AS "visitedAt",
             cv.had_sale                        AS "hadSale",
             cv.visit_note                      AS "visitNote",
             cv.lat, cv.lng
      FROM customer_visits cv
      LEFT JOIN reps r ON r.id = cv.rep_id
      WHERE cv.customer_id = $1
        AND ($2::timestamptz IS NULL OR cv.visited_at >= $2)
        AND ($3::timestamptz IS NULL OR cv.visited_at <= $3)
      ORDER BY cv.visited_at DESC
      LIMIT $4
      `,
      [customerId, from, to, limit],
    )) as CustomerVisitRow[];
  }

  async remove(id: string): Promise<void> {
    const res = await this.customers.softDelete(id);
    if (!res.affected) throw new NotFoundException(`Customer ${id} not found`);
  }

  /**
   * Bulk CSV import. Columns: number,name,address,phone,category
   * Good rows commit; bad rows are reported. Transaction holds for the batch.
   */
  async importCsv(buffer: Buffer): Promise<CsvImportResult> {
    let records: Record<string, string>[];
    try {
      records = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (err) {
      throw new BadRequestException(`Malformed CSV: ${(err as Error).message}`);
    }

    if (records.length === 0) {
      throw new BadRequestException('CSV has no data rows');
    }
    if (records.length > 5000) {
      throw new BadRequestException('CSV exceeds 5000 rows');
    }

    const result: CsvImportResult = { inserted: 0, skipped: 0, errors: [] };

    await this.customers.manager.transaction(async (em) => {
      const repo = em.getRepository(Customer);
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const number = row.number ?? row.customerNumber ?? row.customer_number;
        const name = row.name ?? row.customerName ?? row.customer_name;
        if (!number || !name) {
          result.errors.push({ row: i + 2, reason: 'missing number or name' });
          result.skipped++;
          continue;
        }
        const dup = await repo.exist({ where: { customerNumber: number } });
        if (dup) {
          result.errors.push({ row: i + 2, reason: `duplicate ${number}` });
          result.skipped++;
          continue;
        }
        const phone = row.phone ?? null;
        await repo.save(
          repo.create({
            customerNumber: number,
            customerName: name,
            nameAr: row.name_ar ?? name,
            addressAr: row.address ?? null,
            phone,
            phoneHash: hashPhone(phone),
            category: row.category ?? null,
          }),
        );
        result.inserted++;
      }
    });

    return result;
  }

  /** Enqueue an AI-profile refresh job (real model integration in plan 08). */
  async requestAiRefresh(id: string): Promise<{ queued: boolean }> {
    await this.findOneOrThrow(id);
    const jobId = await this.jobs.enqueue(AI_PROFILE_REFRESH_QUEUE, { customerId: id });
    this.logger.log(`Queued AI refresh for customer ${id} (job ${jobId ?? 'disabled'})`);
    return { queued: jobId !== null };
  }

  /** Internal helper to upsert an AI profile (used by the pipeline + tests). */
  async upsertAiProfile(
    profile: Omit<CustomerAiProfile, 'updatedAt'>,
  ): Promise<CustomerAiProfile> {
    await this.findOneOrThrow(profile.customerId);
    // customer_id is the PK, so save() inserts or updates in one call.
    const entity = this.aiProfiles.create({ ...profile, updatedAt: new Date() });
    await this.aiProfiles.save(entity);
    return this.aiProfiles.findOneOrFail({ where: { customerId: profile.customerId } });
  }

  // ---- Attachments (documents / scans / data sheets) --------------------

  /** Accepted upload types: documents + spreadsheets/images. */
  private static readonly ATTACHMENT_MIME_ALLOW = new Set<string>([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]);

  private static readonly ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

  /** List a customer's attachments, newest first. */
  async listAttachments(customerId: string): Promise<CustomerAttachment[]> {
    await this.findOneOrThrow(customerId);
    return this.attachments.find({
      where: { customerId },
      order: { createdAt: 'DESC' },
    });
  }

  /** Store an uploaded file against a customer and record its metadata. */
  async addAttachment(
    customerId: string,
    file: Express.Multer.File | undefined,
    uploadedBy: string | null,
  ): Promise<CustomerAttachment> {
    await this.findOneOrThrow(customerId);
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (!CustomersService.ATTACHMENT_MIME_ALLOW.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
    }
    if (file.size > CustomersService.ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException('File too large (max 10 MB)');
    }

    const original = this.sanitizeFilename(file.originalname || 'file');
    const key = `customers/${customerId}/${randomUUID()}-${original}`;
    const url = await this.storage.save(key, file.buffer);

    const row = this.attachments.create({
      customerId,
      storageKey: key,
      url,
      originalName: file.originalname || original,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy: uploadedBy ?? null,
    });
    return this.attachments.save(row);
  }

  /** Fetch an attachment row + its bytes for an authenticated download. */
  async getAttachmentFile(
    customerId: string,
    attachmentId: string,
  ): Promise<{ attachment: CustomerAttachment; buffer: Buffer }> {
    const row = await this.attachments.findOne({
      where: { id: attachmentId, customerId },
    });
    if (!row) {
      throw new NotFoundException('Attachment not found');
    }
    const buffer = await this.storage.read(row.storageKey);
    return { attachment: row, buffer };
  }

  /** Delete an attachment (its bytes and the row). */
  async removeAttachment(customerId: string, attachmentId: string): Promise<void> {
    const row = await this.attachments.findOne({
      where: { id: attachmentId, customerId },
    });
    if (!row) {
      throw new NotFoundException('Attachment not found');
    }
    await this.storage.delete(row.storageKey);
    await this.attachments.delete({ id: attachmentId });
  }

  /** Strip path separators / control chars so the storage key stays safe. */
  private sanitizeFilename(name: string): string {
    return name
      .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 120);
  }
}

/**
 * Read an ExcelJS cell value as trimmed text — cells can be a plain string/number,
 * a formula ({ result }), a hyperlink ({ text }), or rich text ({ richText: [...] }).
 */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as {
      result?: unknown;
      text?: unknown;
      richText?: Array<{ text?: string }>;
    };
    if (o.result != null) return String(o.result).trim();
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text ?? '').join('').trim();
    if (o.text != null) return String(o.text).trim();
    return '';
  }
  return String(v).trim();
}

/**
 * Normalize a customer name for matching: collapse whitespace, trim, lowercase
 * (for Latin), then fold the common Arabic spelling variants — alef forms
 * (أ إ آ ٱ → ا), alef-maqsura (ى → ي), taa-marbuta (ة → ه), tatweel, and the
 * harakat diacritics — so "الخمايسة" and "الخمايسه" match. Folding can only ever
 * merge two names; if that merges two DIFFERENT real customers the caller reports
 * it as ambiguous and assigns neither, so it never mis-assigns.
 */
function normalizeName(v: string | null | undefined): string {
  if (v == null) return '';
  return String(v)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/ـ/g, '') // ـ tatweel
    .replace(/[ً-ْ]/g, ''); // harakat / diacritics
}

/**
 * Normalize a salesman id for matching: an all-digit id has its leading zeros
 * stripped ("00008" → "8"), so a zero-padded ERP export matches a rep stored as
 * "8". Non-numeric ids (rep codes) are returned trimmed, unchanged.
 */
function normSalesman(v: string): string {
  const t = v.trim();
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t;
}
