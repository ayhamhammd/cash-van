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
      case 'PAYMENT_METHOD_DISCOUNT':
        this.req(
          t.paymentCondition,
          'PAYMENT_METHOD_DISCOUNT requires trigger.paymentCondition (CASH|CREDIT)',
        );
        if (t.paymentCondition !== 'CASH' && t.paymentCondition !== 'CREDIT') {
          throw new BadRequestException(
            'trigger.paymentCondition must be CASH or CREDIT',
          );
        }
        if (t.minOrderTotal != null && t.minOrderTotal < 0) {
          throw new BadRequestException(
            'trigger.minOrderTotal must be ≥ 0 (fils)',
          );
        }
        if (t.minItemCount != null && t.minItemCount < 1) {
          throw new BadRequestException('trigger.minItemCount must be ≥ 1');
        }
        if (t.maxItemCount != null && t.maxItemCount < 1) {
          throw new BadRequestException('trigger.maxItemCount must be ≥ 1');
        }
        if (
          t.minItemCount != null &&
          t.maxItemCount != null &&
          t.maxItemCount < t.minItemCount
        ) {
          throw new BadRequestException(
            'trigger.maxItemCount must be ≥ minItemCount (quantity band)',
          );
        }
        this.assertLineReward(reward);
        break;
      case 'ITEM_QTY_REWARD':
        this.req(
          t.itemNumbers?.length,
          'ITEM_QTY_REWARD requires trigger.itemNumbers',
        );
        this.assertItemReward(reward);
        break;
      default:
        throw new BadRequestException(`Unknown offer type ${type}`);
    }
  }

  private assertLineReward(reward: OfferRewardDto): void {
    if (reward?.kind === 'LINE_PERCENT_DISCOUNT') {
      this.assertPercentFields(reward);
    } else if (reward?.kind === 'LINE_AMOUNT_DISCOUNT') {
      this.assertAmountFields(reward);
    } else if (reward?.kind === 'TABLE_AMOUNT_DISCOUNT') {
      this.assertTableEntries(reward, 'amount');
    } else if (reward?.kind === 'TABLE_PERCENT_DISCOUNT') {
      this.assertTableEntries(reward, 'percent');
    } else {
      throw new BadRequestException(
        'PAYMENT_METHOD_DISCOUNT requires a LINE_PERCENT_DISCOUNT, LINE_AMOUNT_DISCOUNT, TABLE_AMOUNT_DISCOUNT or TABLE_PERCENT_DISCOUNT reward',
      );
    }
  }

  /**
   * Per-item table validation: non-empty rows, unique items, and each row carries
   * a valid value for its kind (fils amount or 0–100 percent). Unlisted items are
   * simply not discounted, so no coverage requirement here.
   */
  private assertTableEntries(
    reward: OfferRewardDto,
    kind: 'amount' | 'percent',
  ): void {
    const entries = reward.entries ?? [];
    if (!entries.length) {
      throw new BadRequestException(
        'TABLE_*_DISCOUNT requires at least one entry',
      );
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.itemNumber) {
        throw new BadRequestException('Each table entry requires an itemNumber');
      }
      if (seen.has(e.itemNumber)) {
        throw new BadRequestException(
          `Duplicate item ${e.itemNumber} in the discount table`,
        );
      }
      seen.add(e.itemNumber);
      if (kind === 'amount') {
        if (e.amountFils == null || e.amountFils < 0) {
          throw new BadRequestException(
            `Table entry ${e.itemNumber} requires amountFils ≥ 0`,
          );
        }
        if (
          e.maxPercentOfPrice != null &&
          (e.maxPercentOfPrice < 0 || e.maxPercentOfPrice > 100)
        ) {
          throw new BadRequestException(
            `Table entry ${e.itemNumber} maxPercentOfPrice must be 0–100`,
          );
        }
      } else {
        if (e.percent == null || e.percent < 0 || e.percent > 100) {
          throw new BadRequestException(
            `Table entry ${e.itemNumber} requires percent 0–100`,
          );
        }
      }
    }
  }

  private assertItemReward(reward: OfferRewardDto): void {
    if (reward?.kind === 'GIFT') {
      this.req(reward.giftItems?.length, 'GIFT reward requires giftItems[]');
      if (reward.itemsPerGift == null || reward.itemsPerGift < 1) {
        throw new BadRequestException('GIFT reward requires itemsPerGift ≥ 1');
      }
      if (reward.giftsPerStep != null && reward.giftsPerStep < 1) {
        throw new BadRequestException('GIFT giftsPerStep must be ≥ 1');
      }
      if (reward.maxFreeQty != null && reward.maxFreeQty < 1) {
        throw new BadRequestException('GIFT maxFreeQty must be ≥ 1');
      }
    } else if (reward?.kind === 'ITEM_PERCENT_DISCOUNT') {
      this.req(reward.minQty, 'ITEM_PERCENT_DISCOUNT requires reward.minQty');
      this.assertPercentFields(reward);
    } else if (reward?.kind === 'ITEM_AMOUNT_DISCOUNT') {
      this.req(reward.minQty, 'ITEM_AMOUNT_DISCOUNT requires reward.minQty');
      this.assertAmountFields(reward);
    } else {
      throw new BadRequestException(
        'ITEM_QTY_REWARD requires a GIFT, ITEM_PERCENT_DISCOUNT or ITEM_AMOUNT_DISCOUNT reward',
      );
    }
  }

  /** Validation for the amount-off fields (base/mode/dynamic), mirroring the
   *  percentage rules but in fils. */
  private assertAmountFields(reward: OfferRewardDto): void {
    if (reward.baseAmountFils == null || reward.baseAmountFils < 0) {
      throw new BadRequestException('reward.baseAmountFils must be ≥ 0 (fils)');
    }
    if (reward.mode !== 'STATIC' && reward.mode !== 'DYNAMIC') {
      throw new BadRequestException('reward.mode must be STATIC or DYNAMIC');
    }
    if (reward.mode === 'DYNAMIC') {
      if (reward.multiplier == null || reward.multiplier <= 0) {
        throw new BadRequestException(
          'DYNAMIC reward requires reward.multiplier > 0',
        );
      }
      if (reward.itemsPerStep == null || reward.itemsPerStep < 1) {
        throw new BadRequestException(
          'DYNAMIC reward requires reward.itemsPerStep ≥ 1',
        );
      }
      if (
        reward.maxAmountFils != null &&
        reward.maxAmountFils < reward.baseAmountFils
      ) {
        throw new BadRequestException(
          'reward.maxAmountFils must be ≥ baseAmountFils (fils)',
        );
      }
    }
  }

  /** Shared validation for the percentage fields (base/mode/dynamic). */
  private assertPercentFields(reward: OfferRewardDto): void {
    if (
      reward.basePercent == null ||
      reward.basePercent < 0 ||
      reward.basePercent > 100
    ) {
      throw new BadRequestException('reward.basePercent must be 0–100');
    }
    if (reward.mode !== 'STATIC' && reward.mode !== 'DYNAMIC') {
      throw new BadRequestException('reward.mode must be STATIC or DYNAMIC');
    }
    if (reward.mode === 'DYNAMIC') {
      if (reward.multiplier == null || reward.multiplier <= 0) {
        throw new BadRequestException(
          'DYNAMIC reward requires reward.multiplier > 0',
        );
      }
      if (reward.itemsPerStep == null || reward.itemsPerStep < 1) {
        throw new BadRequestException(
          'DYNAMIC reward requires reward.itemsPerStep ≥ 1',
        );
      }
      if (
        reward.maxPercent != null &&
        (reward.maxPercent < reward.basePercent || reward.maxPercent > 100)
      ) {
        throw new BadRequestException(
          'reward.maxPercent must be between basePercent and 100',
        );
      }
    }
  }

  private req(value: unknown, message: string): void {
    if (value === undefined || value === null || value === '' || value === 0) {
      throw new BadRequestException(message);
    }
  }
}
