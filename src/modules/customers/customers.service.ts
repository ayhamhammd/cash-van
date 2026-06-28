import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, Repository } from 'typeorm';
import { parse } from 'csv-parse/sync';

import { Customer } from './entities/customer.entity';
import { CustomerAiProfile } from './entities/customer-ai-profile.entity';
import { CustomerVisit } from './entities/customer-visit.entity';
import { CustomerAttachment } from './entities/customer-attachment.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQuery } from './dto/list-customers.query';
import { CreateVisitDto } from './dto/create-visit.dto';
import { hashPhone } from '../../common/utils/phone-hash.util';
import { JobsService } from '../../common/jobs/jobs.service';
import { StorageService } from '../../common/storage/storage.service';
import { randomUUID } from 'crypto';

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

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(CustomerAiProfile)
    private readonly aiProfiles: Repository<CustomerAiProfile>,
    @InjectRepository(CustomerVisit)
    private readonly visits: Repository<CustomerVisit>,
    @InjectRepository(CustomerAttachment)
    private readonly attachments: Repository<CustomerAttachment>,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    private readonly events: EventEmitter2,
  ) {}

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
    });
    const saved = await this.customers.save(entity);
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

  async findOneOrThrow(id: string): Promise<Customer> {
    const c = await this.customers.findOne({ where: { id } });
    if (!c) throw new NotFoundException(`Customer ${id} not found`);
    return c;
  }

  async list(query: ListCustomersQuery): Promise<{ items: Customer[]; total: number }> {
    const qb = this.customers
      .createQueryBuilder('c')
      .where('c.deleted_at IS NULL')
      .orderBy('c.created_at', 'DESC')
      .take(query.limit ?? 25)
      .skip(query.offset ?? 0);

    if (query.unassigned) qb.andWhere('c.rep_id IS NULL');
    else if (query.repId) qb.andWhere('c.rep_id = :repId', { repId: query.repId });
    if (query.regionId) qb.andWhere('c.region_id = :regionId', { regionId: query.regionId });
    if (query.isActive !== undefined) qb.andWhere('c.is_active = :a', { a: query.isActive });

    if (query.q) {
      qb.andWhere(
        new Brackets((b) => {
          const p = `%${query.q}%`;
          b.where('c.name_ar ILIKE :p', { p })
            .orWhere('c.name_en ILIKE :p', { p })
            .orWhere('c.customer_number ILIKE :p', { p });
        }),
      );
    }

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
    customer.repId = newRepId;
    return this.customers.save(customer);
  }

  async addVisit(customerId: string, dto: CreateVisitDto): Promise<CustomerVisit> {
    await this.findOneOrThrow(customerId);
    return this.visits.save(
      this.visits.create({
        customerId,
        repId: dto.repId,
        visitedAt: dto.visitedAt ? new Date(dto.visitedAt) : new Date(),
        hadSale: dto.hadSale ?? false,
        visitNote: dto.visitNote ?? null,
        lat: dto.lat ?? null,
        lng: dto.lng ?? null,
      }),
    );
  }

  async listVisits(customerId: string, limit = 50): Promise<CustomerVisit[]> {
    await this.findOneOrThrow(customerId);
    return this.visits.find({
      where: { customerId },
      order: { visitedAt: 'DESC' },
      take: limit,
    });
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
