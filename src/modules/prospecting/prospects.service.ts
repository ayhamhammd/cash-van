import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, Not, Repository } from 'typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Prospect } from './entities/prospect.entity';
import { ProspectSearch } from './entities/prospect-search.entity';
import { QuoteTemplate } from './entities/quote-template.entity';
import { PlacesService } from './places.service';
import { WhatsappService } from './whatsapp.service';
import { matchExistingCustomer, type DedupCustomer } from './dedup.util';
import { PROSPECT_CATEGORIES } from './prospecting.types';
import {
  ConvertProspectDto,
  CreateProspectSearchDto,
  ListProspectsQueryDto,
  SendQuoteDto,
  UpdateProspectDto,
} from './dto/prospect.dto';

@Injectable()
export class ProspectsService {
  constructor(
    @InjectRepository(Prospect)
    private readonly prospects: Repository<Prospect>,
    @InjectRepository(ProspectSearch)
    private readonly searches: Repository<ProspectSearch>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(QuoteTemplate)
    private readonly templates: Repository<QuoteTemplate>,
    private readonly places: PlacesService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run a lead-finder search: Places nearby → phone lookup → de-dup against
   * existing customers → upsert prospects.
   *
   * Upsert (not insert) is deliberate: `googlePlaceId` is unique, so searching
   * an overlapping area again refreshes the business details while preserving
   * the rep's status, notes and outreach timestamps on leads already worked.
   */
  async search(
    dto: CreateProspectSearchDto,
    userId?: string,
  ): Promise<{ search: ProspectSearch; prospects: Prospect[] }> {
    const categories = dto.categories ?? [];
    // Case-insensitively de-duplicated: the same term twice is the same search
    // run twice, and each one is a billed call. The first spelling wins, so
    // what comes back is what the user typed first.
    const seen = new Set<string>();
    const keywords = (dto.keywords ?? [])
      .map((k) => k.trim())
      .filter((k) => {
        if (!k || seen.has(k.toLowerCase())) return false;
        seen.add(k.toLowerCase());
        return true;
      });

    if (!categories.length && !keywords.length) {
      throw new BadRequestException(
        'Provide at least one category or search term.',
      );
    }

    const bad = categories.filter(
      (c) => !PROSPECT_CATEGORIES.includes(c as never),
    );
    if (bad.length) {
      throw new BadRequestException(`Unsupported categories: ${bad.join(', ')}`);
    }

    // Two Places SKUs, one pipeline: the ticked types ride along in a single
    // nearby call, each of the caller's own terms costs a text search. A place
    // can come back from several (a term matching a supermarket's name while
    // `supermarket` is also ticked), so they are de-duplicated by place id
    // before we spend a Details call each.
    const [byCategory, ...byKeyword] = await Promise.all([
      categories.length
        ? this.places.searchNearby(dto.lat, dto.lng, dto.radiusM, categories)
        : Promise.resolve([]),
      ...keywords.map((k) =>
        this.places.searchTextNearby(k, dto.lat, dto.lng, dto.radiusM),
      ),
    ]);

    const byId = new Map(
      [...byCategory, ...byKeyword.flat()].map((p) => [p.placeId, p]),
    );
    const found = [...byId.values()];

    // Only customers that can actually match on something are worth loading.
    const candidates = (await this.customers.find({
      select: [
        'id',
        'phone',
        'nameAr',
        'customerName',
        'latitude',
        'longitude',
      ],
    })) as DedupCustomer[];

    const search = await this.searches.save(
      this.searches.create({
        centerLat: String(dto.lat),
        centerLng: String(dto.lng),
        radiusM: dto.radiusM,
        categories,
        keywords,
        foundCount: found.length,
        newCount: 0,
        createdBy: userId ?? null,
      }),
    );

    const saved: Prospect[] = [];
    let newCount = 0;

    for (const place of found) {
      const phone = await this.places.fetchPhone(place.placeId);
      const hit = matchExistingCustomer(
        { name: place.name, phone, lat: place.lat, lng: place.lng },
        candidates,
      );
      if (!hit) newCount += 1;

      const existing = await this.prospects.findOne({
        where: { googlePlaceId: place.placeId },
        withDeleted: true,
      });

      if (existing) {
        // Refresh facts + re-evaluate the match, but never clobber the human's
        // work (status/notes/sentAt) on a lead already being pursued.
        existing.searchId = search.id;
        existing.name = place.name;
        existing.lat = place.lat != null ? String(place.lat) : null;
        existing.lng = place.lng != null ? String(place.lng) : null;
        existing.address = place.address;
        existing.phone = phone ?? existing.phone ?? null;
        existing.category = place.category;
        existing.rating = place.rating != null ? String(place.rating) : null;
        existing.matchedCustomerId = hit?.customerId ?? null;
        existing.matchReason = hit?.reason ?? null;
        existing.deletedAt = null;
        saved.push(await this.prospects.save(existing));
        continue;
      }

      saved.push(
        await this.prospects.save(
          this.prospects.create({
            searchId: search.id,
            googlePlaceId: place.placeId,
            name: place.name,
            lat: place.lat != null ? String(place.lat) : null,
            lng: place.lng != null ? String(place.lng) : null,
            address: place.address,
            phone,
            category: place.category,
            rating: place.rating != null ? String(place.rating) : null,
            status: 'NEW',
            matchedCustomerId: hit?.customerId ?? null,
            matchReason: hit?.reason ?? null,
          }),
        ),
      );
    }

    search.newCount = newCount;
    await this.searches.save(search);
    return { search, prospects: saved };
  }

  async listSearches(): Promise<ProspectSearch[]> {
    return this.searches.find({ order: { createdAt: 'DESC' }, take: 50 });
  }

  async listProspects(
    q: ListProspectsQueryDto,
  ): Promise<PaginatedResult<Prospect>> {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const qb = this.prospects
      .createQueryBuilder('p')
      .orderBy('p.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (q.searchId) qb.andWhere('p.searchId = :sid', { sid: q.searchId });
    if (q.status) qb.andWhere('p.status = :st', { st: q.status });
    if (q.newOnly === 'true') qb.andWhere('p.matchedCustomerId IS NULL');
    if (q.search) {
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('p.name ILIKE :s', { s: `%${q.search}%` })
            .orWhere('p.address ILIKE :s', { s: `%${q.search}%` }),
        ),
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(id: string): Promise<Prospect> {
    const row = await this.prospects.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Prospect not found');
    return row;
  }

  async update(id: string, dto: UpdateProspectDto): Promise<Prospect> {
    const row = await this.findOne(id);
    Object.assign(row, dto);
    return this.prospects.save(row);
  }

  /**
   * Called when the rep opens the WhatsApp chat. Only advances a lead that is
   * still NEW/QUOTED — it must never drag a CONVERTED lead backwards.
   */
  async markSent(id: string): Promise<Prospect> {
    const row = await this.findOne(id);
    row.sentAt = new Date();
    if (row.status === 'NEW' || row.status === 'QUOTED') {
      row.status = 'CONTACTED';
    }
    return this.prospects.save(row);
  }

  /**
   * Send the quote to a prospect over WhatsApp through the OpenWA gateway, then
   * stamp it contacted. The message is composed entirely server-side from the
   * template: the caller picks WHICH template, never WHAT the text says, so the
   * company's number can't be used to send arbitrary content.
   *
   * The prospect is only marked sent after the gateway accepts the message —
   * a failed send leaves the lead untouched so it can be retried.
   */
  async sendQuote(
    id: string,
    dto: SendQuoteDto,
  ): Promise<{ prospect: Prospect; chatId: string; messageId: string | null }> {
    const row = await this.findOne(id);
    if (row.matchedCustomerId) {
      throw new BadRequestException('This lead is already an existing customer');
    }
    if (!row.phone) {
      throw new BadRequestException('This lead has no phone number');
    }

    const template = dto.templateId
      ? await this.templates.findOne({
          where: { id: dto.templateId, isActive: true },
        })
      : await this.templates.findOne({
          where: { isActive: true },
          order: { createdAt: 'ASC' },
        });
    if (!template) {
      throw new BadRequestException(
        'No active quote template — create one before sending',
      );
    }

    const base = this.config.get<string>('publicDashboardUrl');
    if (!base) {
      throw new BadRequestException(
        'PUBLIC_DASHBOARD_URL is not set — the quote link cannot be built',
      );
    }
    // `?p=` is what turns a plain quote view into per-prospect open tracking.
    const link = `${base}/q/${template.publicToken}?p=${row.id}`;
    const text = [template.whatsappMessageAr?.trim(), link]
      .filter(Boolean)
      .join('\n');

    const sent = await this.whatsapp.sendText(row.phone, text);

    row.sentAt = new Date();
    if (row.status === 'NEW' || row.status === 'QUOTED') {
      row.status = 'CONTACTED';
    }
    const prospect = await this.prospects.save(row);
    return { prospect, chatId: sent.chatId, messageId: sent.messageId };
  }

  /** Public quote open — first open wins, so the timestamp is first-touch. */
  async markLinkOpened(id: string): Promise<void> {
    const row = await this.prospects.findOne({ where: { id } });
    if (!row || row.linkOpenedAt) return;
    row.linkOpenedAt = new Date();
    await this.prospects.save(row);
  }

  /** Promote a prospect into a real customer and link the two records. */
  async convert(id: string, dto: ConvertProspectDto): Promise<Customer> {
    const row = await this.findOne(id);
    if (row.matchedCustomerId) {
      throw new ConflictException('This prospect is already an existing customer');
    }
    const clash = await this.customers.findOne({
      where: { customerNumber: dto.customerNumber },
    });
    if (clash) throw new ConflictException('Customer number already exists');

    const customer = await this.customers.save(
      this.customers.create({
        customerNumber: dto.customerNumber,
        customerName: row.name,
        nameAr: row.name,
        phone: row.phone ?? null,
        addressAr: row.address ?? null,
        latitude: row.lat ?? null,
        longitude: row.lng ?? null,
        repId: dto.repId ?? null,
        // Same provenance the handset path records, so a customer converted
        // here and one filed from the app are indistinguishable in the report.
        source: 'PROSPECTING',
        sourceProspectId: row.id,
      }),
    );

    row.status = 'CONVERTED';
    row.matchedCustomerId = customer.id;
    await this.prospects.save(row);
    return customer;
  }

  /**
   * The salesman app filed a customer straight from a lead, so close the lead.
   *
   * Event-driven because customers cannot import this module — prospecting
   * already depends on customers for convert(), and the reverse would be a
   * cycle. Failure here must not undo a customer that is already saved, so it
   * logs and moves on rather than throwing.
   */
  @OnEvent('prospect.converted')
  async onProspectConverted(p: { prospectId: string; customerId: string }): Promise<void> {
    const row = await this.prospects.findOne({ where: { id: p.prospectId } });
    if (!row) return;
    row.status = 'CONVERTED';
    row.matchedCustomerId = p.customerId;
    await this.prospects.save(row);
  }

  /** Pipeline counters for the KPI strip. */
  async stats(): Promise<Record<string, number>> {
    const rows = await this.prospects
      .createQueryBuilder('p')
      .select('p.status', 'status')
      .addSelect('count(*)', 'count')
      .groupBy('p.status')
      .getRawMany<{ status: string; count: string }>();
    const out: Record<string, number> = {
      NEW: 0,
      QUOTED: 0,
      CONTACTED: 0,
      CONVERTED: 0,
      REJECTED: 0,
    };
    for (const r of rows) out[r.status] = Number(r.count);
    out.opened = await this.prospects.count({
      where: { linkOpenedAt: Not(IsNull()) },
    });
    out.existing = await this.prospects.count({
      where: { matchedCustomerId: Not(IsNull()) },
    });
    return out;
  }
}
