import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Offer } from './entities/offer.entity';
import { OfferRedemption } from './entities/offer-redemption.entity';
import { OffersEngineService } from './offers-engine.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { UpdateOfferDto } from './dto/update-offer.dto';
import { ListOffersQueryDto } from './dto/list-offers.dto';
import type { OfferRewardDto, OfferTriggerDto } from './dto/offer-config.dto';
import type {
  AppliesTo,
  CartLineInput,
  FreeItemSpec,
  OfferEligibility,
  OfferRewardConfig,
  OfferTriggerConfig,
  OfferType,
} from './offers.types';

export type OfferStatus = 'active' | 'paused' | 'scheduled' | 'expired';
export type OfferView = Offer & { status: OfferStatus };

export interface OfferListResult extends PaginatedResult<OfferView> {
  stats: {
    active: number;
    scheduled: number;
    expired: number;
    redemptionsThisMonth: number;
  };
}

export interface RedemptionReport extends PaginatedResult<OfferRedemption> {
  totals: { count: number; discountFils: number };
}

@Injectable()
export class OffersService {
  constructor(
    @InjectRepository(Offer)
    private readonly offersRepo: Repository<Offer>,
    @InjectRepository(OfferRedemption)
    private readonly redemptionsRepo: Repository<OfferRedemption>,
    private readonly engine: OffersEngineService,
  ) {}

  // ---- CRUD ----

  async create(dto: CreateOfferDto): Promise<OfferView> {
    this.validateConfig(dto.type, dto.trigger, dto.reward);
    const offer = this.offersRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      type: dto.type,
      trigger: dto.trigger as unknown as OfferTriggerConfig,
      reward: dto.reward as unknown as OfferRewardConfig,
      eligibility: (dto.eligibility ?? { customerScope: 'ALL' }) as OfferEligibility,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
      validTo: dto.validTo ? new Date(dto.validTo) : null,
      daysOfWeek: dto.daysOfWeek ?? null,
      timeFrom: dto.timeFrom ?? null,
      timeTo: dto.timeTo ?? null,
      totalRedemptionLimit: dto.totalRedemptionLimit ?? null,
      perCustomerLimit: dto.perCustomerLimit ?? null,
      priority: dto.priority ?? 0,
      stackable: dto.stackable ?? false,
      isActive: dto.isActive ?? true,
    });
    return this.toView(await this.offersRepo.save(offer));
  }

  async findAll(query: ListOffersQueryDto): Promise<OfferListResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const now = new Date();

    const qb = this.offersRepo.createQueryBuilder('o');
    if (query.type) qb.andWhere('o.type = :type', { type: query.type });
    if (query.search) {
      qb.andWhere('o.name ILIKE :q', { q: `%${query.search}%` });
    }
    this.applyStatusFilter(qb, query.status, now);

    const [items, total] = await qb
      .orderBy('o.priority', 'DESC')
      .addOrderBy('o.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items: items.map((o) => this.toView(o, now)),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      stats: await this.stats(now),
    };
  }

  async findOne(id: string): Promise<OfferView> {
    return this.toView(await this.findOneOrThrow(id));
  }

  /**
   * Currently-active offers for a sale device to cache/sync. Returns a plain
   * array (no pagination) of offers whose schedule is live now. Eligibility and
   * limits are NOT fully applied here — the device previews with this list and
   * the server stays authoritative at /offers/evaluate. The only narrowing done
   * is the optional store scope (so a van doesn't cache offers for other stores).
   */
  async findActive(
    customerNumber?: string,
    storeNumber?: string,
  ): Promise<OfferView[]> {
    const now = new Date();
    const qb = this.offersRepo.createQueryBuilder('o');
    this.applyStatusFilter(qb, 'active', now);
    const offers = await qb
      .orderBy('o.priority', 'DESC')
      .addOrderBy('o.created_at', 'ASC')
      .getMany();

    const scoped = storeNumber
      ? offers.filter((o) => {
          const stores = o.eligibility?.storeNumbers;
          return !stores || stores.length === 0 || stores.includes(storeNumber);
        })
      : offers;

    return scoped.map((o) => this.toView(o, now));
  }

  async update(id: string, dto: UpdateOfferDto): Promise<OfferView> {
    const offer = await this.findOneOrThrow(id);

    // Validate the EFFECTIVE config (existing merged with the patch).
    const type = (dto.type ?? offer.type) as OfferType;
    const trigger = (dto.trigger ?? offer.trigger) as OfferTriggerDto;
    const reward = (dto.reward ?? offer.reward) as OfferRewardDto;
    if (dto.type || dto.trigger || dto.reward) {
      this.validateConfig(type, trigger, reward);
    }

    Object.assign(offer, {
      name: dto.name ?? offer.name,
      description: dto.description ?? offer.description,
      type,
      trigger,
      reward,
      eligibility: dto.eligibility ?? offer.eligibility,
      validFrom:
        dto.validFrom !== undefined
          ? dto.validFrom
            ? new Date(dto.validFrom)
            : null
          : offer.validFrom,
      validTo:
        dto.validTo !== undefined
          ? dto.validTo
            ? new Date(dto.validTo)
            : null
          : offer.validTo,
      daysOfWeek: dto.daysOfWeek ?? offer.daysOfWeek,
      timeFrom: dto.timeFrom ?? offer.timeFrom,
      timeTo: dto.timeTo ?? offer.timeTo,
      totalRedemptionLimit:
        dto.totalRedemptionLimit ?? offer.totalRedemptionLimit,
      perCustomerLimit: dto.perCustomerLimit ?? offer.perCustomerLimit,
      priority: dto.priority ?? offer.priority,
      stackable: dto.stackable ?? offer.stackable,
      isActive: dto.isActive ?? offer.isActive,
    });
    return this.toView(await this.offersRepo.save(offer));
  }

  async toggle(id: string): Promise<OfferView> {
    const offer = await this.findOneOrThrow(id);
    offer.isActive = !offer.isActive;
    return this.toView(await this.offersRepo.save(offer));
  }

  async remove(id: string): Promise<void> {
    await this.findOneOrThrow(id);
    await this.offersRepo.softDelete(id);
  }

  // ---- redemptions report ----

  async redemptions(
    id: string,
    page = 1,
    limit = 25,
  ): Promise<RedemptionReport> {
    await this.findOneOrThrow(id);
    const [items, total] = await this.redemptionsRepo.findAndCount({
      where: { offerId: id },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totals = await this.redemptionsRepo
      .createQueryBuilder('r')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(r.discountFils), 0)', 'discountFils')
      .where('r.offerId = :id', { id })
      .getRawOne<{ count: string; discountFils: string }>();
    return {
      items,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      totals: {
        count: Number(totals?.count ?? 0),
        discountFils: Number(totals?.discountFils ?? 0),
      },
    };
  }

  /**
   * Record one redemption per offer the sale asserts it applied. Best-effort:
   * the caller wraps this so a failure never blocks the voucher. Discount/free
   * amounts are recomputed from the cart so the report reflects reality.
   */
  async recordRedemptions(params: {
    voucherNumber?: string | null;
    customerNumber?: string | null;
    offerIds: string[];
    lines: CartLineInput[];
  }): Promise<void> {
    const rewards = await this.engine.computeForOffers(
      params.offerIds,
      params.lines,
    );
    if (!rewards.length) return;
    const rows = rewards.map((r) =>
      this.redemptionsRepo.create({
        offerId: r.offerId,
        voucherNumber: params.voucherNumber ?? null,
        customerNumber: params.customerNumber ?? null,
        discountFils: r.discountFils,
        freeItems: r.freeItems,
      }),
    );
    await this.redemptionsRepo.save(rows);
    for (const r of rewards) {
      await this.offersRepo.increment({ id: r.offerId }, 'redemptionCount', 1);
    }
  }

  /**
   * Record redemptions from an already-computed evaluation (server-authoritative
   * path: VouchersService applies offers itself, so the discount/free amounts are
   * known and need no recompute). One ledger row per applied offer.
   */
  async recordApplied(params: {
    voucherNumber?: string | null;
    customerNumber?: string | null;
    applied: Array<{
      offerId: string;
      discountFils: number;
      freeItems: FreeItemSpec[];
    }>;
  }): Promise<void> {
    if (!params.applied.length) return;
    const rows = params.applied.map((a) =>
      this.redemptionsRepo.create({
        offerId: a.offerId,
        voucherNumber: params.voucherNumber ?? null,
        customerNumber: params.customerNumber ?? null,
        discountFils: a.discountFils,
        freeItems: a.freeItems,
      }),
    );
    await this.redemptionsRepo.save(rows);
    for (const a of params.applied) {
      await this.offersRepo.increment({ id: a.offerId }, 'redemptionCount', 1);
    }
  }

  // ---- helpers ----

  async findOneOrThrow(id: string): Promise<Offer> {
    const offer = await this.offersRepo.findOne({ where: { id } });
    if (!offer) throw new NotFoundException(`Offer ${id} not found`);
    return offer;
  }

  private toView(offer: Offer, now = new Date()): OfferView {
    return Object.assign(offer, { status: this.deriveStatus(offer, now) });
  }

  private deriveStatus(offer: Offer, now: Date): OfferStatus {
    if (!offer.isActive) return 'paused';
    if (offer.validFrom && now < new Date(offer.validFrom)) return 'scheduled';
    if (offer.validTo && now > new Date(offer.validTo)) return 'expired';
    return 'active';
  }

  private applyStatusFilter(
    qb: import('typeorm').SelectQueryBuilder<Offer>,
    status: ListOffersQueryDto['status'],
    now: Date,
  ): void {
    if (!status || status === 'all') return;
    switch (status) {
      case 'paused':
        qb.andWhere('o.is_active = false');
        break;
      case 'scheduled':
        qb.andWhere('o.is_active = true')
          .andWhere('o.valid_from IS NOT NULL')
          .andWhere('o.valid_from > :now', { now });
        break;
      case 'expired':
        qb.andWhere('o.is_active = true')
          .andWhere('o.valid_to IS NOT NULL')
          .andWhere('o.valid_to < :now', { now });
        break;
      case 'active':
        qb.andWhere('o.is_active = true')
          .andWhere('(o.valid_from IS NULL OR o.valid_from <= :now)', { now })
          .andWhere('(o.valid_to IS NULL OR o.valid_to >= :now)', { now });
        break;
    }
  }

  private async stats(now: Date): Promise<OfferListResult['stats']> {
    const count = (status: OfferStatus): Promise<number> => {
      const qb = this.offersRepo.createQueryBuilder('o');
      this.applyStatusFilter(qb, status, now);
      return qb.getCount();
    };
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [active, scheduled, expired, redemptionsThisMonth] = await Promise.all(
      [
        count('active'),
        count('scheduled'),
        count('expired'),
        this.redemptionsRepo
          .createQueryBuilder('r')
          .where('r.created_at >= :start', { start: monthStart })
          .getCount(),
      ],
    );
    return { active, scheduled, expired, redemptionsThisMonth };
  }

  // ---- per-type config legality ----

  private validateConfig(
    type: OfferType,
    trigger: OfferTriggerDto,
    reward: OfferRewardDto,
  ): void {
    const t = trigger ?? ({} as OfferTriggerDto);
    switch (type) {
      case 'ITEM_QTY_DISCOUNT':
        this.req(t.itemNumber, 'ITEM_QTY_DISCOUNT requires trigger.itemNumber');
        this.req(t.minQty, 'ITEM_QTY_DISCOUNT requires trigger.minQty');
        this.assertDiscount(reward, ['TRIGGER_ITEM']);
        break;
      case 'BUY_X_GET_Y_FREE':
        this.req(t.itemNumber, 'BUY_X_GET_Y_FREE requires trigger.itemNumber');
        this.req(t.qty, 'BUY_X_GET_Y_FREE requires trigger.qty');
        this.assertFree(reward);
        break;
      case 'BASKET_THRESHOLD':
        this.req(
          t.itemNumbers?.length,
          'BASKET_THRESHOLD requires trigger.itemNumbers',
        );
        this.req(
          t.minItemCount,
          'BASKET_THRESHOLD requires trigger.minItemCount',
        );
        this.assertDiscountOrFree(reward, ['INVOICE']);
        break;
      case 'ITEM_SET_THRESHOLD':
        this.req(
          t.itemNumbers?.length,
          'ITEM_SET_THRESHOLD requires trigger.itemNumbers',
        );
        this.req(
          t.minTotalQty,
          'ITEM_SET_THRESHOLD requires trigger.minTotalQty',
        );
        this.req(t.match, 'ITEM_SET_THRESHOLD requires trigger.match (ANY|ALL)');
        this.assertDiscountOrFree(reward, ['SET', 'INVOICE']);
        break;
      case 'LOYALTY_FIRST_PURCHASE':
        this.assertDiscountOrFree(reward, ['INVOICE']);
        break;
      default:
        throw new BadRequestException(`Unknown offer type ${type}`);
    }
  }

  private assertDiscountOrFree(
    reward: OfferRewardDto,
    allowedAppliesTo: AppliesTo[],
  ): void {
    if (reward?.kind === 'DISCOUNT') this.assertDiscount(reward, allowedAppliesTo);
    else this.assertFree(reward);
  }

  private assertDiscount(
    reward: OfferRewardDto,
    allowedAppliesTo: AppliesTo[],
  ): void {
    if (reward?.kind !== 'DISCOUNT') {
      throw new BadRequestException('This offer type requires a DISCOUNT reward');
    }
    if (reward.discountType !== 'PERCENT' && reward.discountType !== 'VALUE') {
      throw new BadRequestException('reward.discountType must be PERCENT or VALUE');
    }
    if (reward.value == null) {
      throw new BadRequestException('reward.value is required for a DISCOUNT');
    }
    if (
      reward.discountType === 'PERCENT' &&
      (reward.value < 0 || reward.value > 100)
    ) {
      throw new BadRequestException('PERCENT reward.value must be 0–100');
    }
    // Default appliesTo to the first allowed option; otherwise it must be legal.
    if (!reward.appliesTo) reward.appliesTo = allowedAppliesTo[0];
    if (!allowedAppliesTo.includes(reward.appliesTo)) {
      throw new BadRequestException(
        `reward.appliesTo must be one of ${allowedAppliesTo.join(', ')} for this offer type`,
      );
    }
    if (reward.appliesTo === 'SET' && reward.discountType === 'VALUE') {
      throw new BadRequestException(
        'SET discounts must be PERCENT (a fixed VALUE across a set is not supported)',
      );
    }
  }

  private assertFree(reward: OfferRewardDto): void {
    if (reward?.kind === 'FREE_ITEM') {
      this.req(reward.items?.length, 'FREE_ITEM reward requires items[]');
    } else if (reward?.kind === 'FREE_ITEM_CHOICE') {
      this.req(reward.choices?.length, 'FREE_ITEM_CHOICE requires choices[]');
      this.req(reward.qty, 'FREE_ITEM_CHOICE requires qty');
    } else {
      throw new BadRequestException(
        'This offer type requires a FREE_ITEM or FREE_ITEM_CHOICE reward',
      );
    }
  }

  private req(value: unknown, message: string): void {
    if (value === undefined || value === null || value === '' || value === 0) {
      throw new BadRequestException(message);
    }
  }
}
