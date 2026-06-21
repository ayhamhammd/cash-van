import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { roundFils } from '../../common/utils/currency.util';
import { ItemCart } from '../items/entities/item-cart.entity';
import { Customer } from '../customers/entities/customer.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { Offer } from './entities/offer.entity';
import { OfferRedemption } from './entities/offer-redemption.entity';
import type {
  AppliedOffer,
  CartLineInput,
  DiscountReward,
  EvaluatedLine,
  EvaluationContext,
  EvaluationResult,
  FreeItemSpec,
  FreeLine,
  OfferEligibility,
} from './offers.types';

interface ItemInfo {
  priceFils: number;
  taxPct: number;
  name: string;
}

/** Reward outcome for one offer against a cart, before stacking/clamping. */
interface RewardOutcome {
  triggerSatisfied: boolean;
  lineDiscounts: Map<string, number>;
  invoiceDiscountFils: number;
  freeItems: FreeItemSpec[];
  freeItemChoice?: { choices: string[]; qty: number };
  discountFils: number;
}

export interface RecordedReward {
  offerId: string;
  discountFils: number;
  freeItems: FreeItemSpec[];
}

/**
 * The discount engine. Stateless w.r.t. the cart: given lines + context it loads
 * the active offers and computes per-line discounts, free lines and invoice
 * discounts. All money is integer fils.
 *
 * Stacking rule: offers are considered in priority order (desc, then oldest
 * first). Stackable offers combine; the first NON-stackable offer that applies
 * ends the chain (nothing applies after it). Schedule, eligibility and limits
 * are all checked before an offer can apply.
 */
@Injectable()
export class OffersEngineService {
  constructor(
    @InjectRepository(Offer)
    private readonly offersRepo: Repository<Offer>,
    @InjectRepository(OfferRedemption)
    private readonly redemptionsRepo: Repository<OfferRedemption>,
    @InjectRepository(ItemCart)
    private readonly itemsRepo: Repository<ItemCart>,
    @InjectRepository(Customer)
    private readonly customersRepo: Repository<Customer>,
    @InjectRepository(VoucherHeader)
    private readonly vouchersRepo: Repository<VoucherHeader>,
  ) {}

  async evaluate(
    lines: CartLineInput[],
    ctx: EvaluationContext = {},
  ): Promise<EvaluationResult> {
    const at = ctx.at ?? new Date();
    const cart = this.toCartMap(lines);

    const offers = await this.offersRepo.find({
      where: { isActive: true },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });

    const itemMap = await this.loadItems(cart, offers);
    const customer = ctx.customerNumber
      ? await this.customersRepo.findOne({
          where: { customerNumber: ctx.customerNumber },
        })
      : null;

    const needsNew = offers.some(
      (o) =>
        o.type === 'LOYALTY_FIRST_PURCHASE' ||
        o.eligibility?.customerScope === 'NEW_ONLY',
    );
    const isNew =
      needsNew && ctx.customerNumber
        ? await this.isNewCustomer(ctx.customerNumber)
        : false;

    const perCustomerCounts = await this.loadPerCustomerCounts(offers, ctx);

    // Working state.
    const work = new Map<
      string,
      { qty: number; unitPriceFils: number; taxPct: number; discountFils: number }
    >();
    for (const [itemNumber, qty] of cart) {
      const info = itemMap.get(itemNumber);
      work.set(itemNumber, {
        qty,
        unitPriceFils: info?.priceFils ?? 0,
        taxPct: info?.taxPct ?? 0,
        discountFils: 0,
      });
    }
    const subtotalFils = [...work.values()].reduce(
      (s, l) => s + roundFils(l.qty * l.unitPriceFils),
      0,
    );

    const freeLines: FreeLine[] = [];
    const appliedOffers: AppliedOffer[] = [];
    let invoiceDiscountFils = 0;
    let locked = false;

    for (const offer of offers) {
      if (locked) break;
      if (!this.isWithinSchedule(offer, at)) continue;
      if (offer.type === 'LOYALTY_FIRST_PURCHASE' && (!customer || !isNew)) continue;
      if (!this.isEligible(offer.eligibility, customer, ctx, isNew)) continue;
      if (
        offer.totalRedemptionLimit != null &&
        offer.redemptionCount >= offer.totalRedemptionLimit
      )
        continue;
      if (offer.perCustomerLimit != null) {
        const used = perCustomerCounts.get(offer.id) ?? 0;
        if (used >= offer.perCustomerLimit) continue;
      }

      const outcome = this.computeReward(offer, cart, itemMap, subtotalFils);
      if (!outcome.triggerSatisfied) continue;

      for (const [itemNumber, fils] of outcome.lineDiscounts) {
        const line = work.get(itemNumber);
        if (line) line.discountFils += fils;
      }
      invoiceDiscountFils += outcome.invoiceDiscountFils;
      for (const free of outcome.freeItems) {
        freeLines.push({
          itemNumber: free.itemNumber,
          qty: free.qty,
          unitPriceFils: itemMap.get(free.itemNumber)?.priceFils ?? 0,
          offerId: offer.id,
        });
      }
      appliedOffers.push({
        offerId: offer.id,
        name: offer.name,
        type: offer.type,
        summary: this.summarize(offer, itemMap),
        discountFils: outcome.discountFils,
        freeItems: outcome.freeItems,
        freeItemChoice: outcome.freeItemChoice,
      });

      if (!offer.stackable) locked = true;
    }

    // Clamp per-line discount to the line gross, then build the response.
    const resultLines: EvaluatedLine[] = [];
    let lineDiscountTotal = 0;
    let taxFils = 0;
    for (const [itemNumber, l] of work) {
      const gross = roundFils(l.qty * l.unitPriceFils);
      const discount = Math.min(l.discountFils, gross);
      const net = gross - discount;
      lineDiscountTotal += discount;
      taxFils += roundFils(net * (l.taxPct / 100));
      resultLines.push({
        itemNumber,
        qty: l.qty,
        unitPriceFils: l.unitPriceFils,
        lineDiscountFils: discount,
        lineNetFils: net,
      });
    }

    const netBeforeInvoiceDiscount = subtotalFils - lineDiscountTotal;
    const clampedInvoiceDiscount = Math.min(
      invoiceDiscountFils,
      netBeforeInvoiceDiscount,
    );
    const grandTotalFils = netBeforeInvoiceDiscount + taxFils - clampedInvoiceDiscount;

    return {
      lines: resultLines,
      freeLines,
      invoiceDiscountFils: clampedInvoiceDiscount,
      appliedOffers,
      totals: {
        subtotalFils,
        lineDiscountFils: lineDiscountTotal,
        invoiceDiscountFils: clampedInvoiceDiscount,
        totalDiscountFils: lineDiscountTotal + clampedInvoiceDiscount,
        taxFils,
        grandTotalFils,
      },
    };
  }

  /**
   * Compute the reward each of the named offers grants against a cart, WITHOUT
   * eligibility/schedule gating (the sale already asserted these applied). Used
   * by the redemption-recording hook. Offers whose trigger isn't satisfied are
   * dropped.
   */
  async computeForOffers(
    offerIds: string[],
    lines: CartLineInput[],
  ): Promise<RecordedReward[]> {
    if (!offerIds.length) return [];
    const cart = this.toCartMap(lines);
    const offers = await this.offersRepo.find({ where: { id: In(offerIds) } });
    if (!offers.length) return [];
    const itemMap = await this.loadItems(cart, offers);
    const subtotalFils = [...cart].reduce(
      (s, [n, q]) => s + roundFils(q * (itemMap.get(n)?.priceFils ?? 0)),
      0,
    );
    const out: RecordedReward[] = [];
    for (const offer of offers) {
      const outcome = this.computeReward(offer, cart, itemMap, subtotalFils);
      if (!outcome.triggerSatisfied) continue;
      out.push({
        offerId: offer.id,
        discountFils: outcome.discountFils,
        freeItems: outcome.freeItems,
      });
    }
    return out;
  }

  // ---- reward computation (pure) ----

  private computeReward(
    offer: Offer,
    cart: Map<string, number>,
    itemMap: Map<string, ItemInfo>,
    subtotalFils: number,
  ): RewardOutcome {
    const t = offer.trigger as Record<string, unknown>;
    const reward = offer.reward;
    const lineDiscounts = new Map<string, number>();
    let invoiceDiscountFils = 0;
    const freeItems: FreeItemSpec[] = [];
    let freeItemChoice: { choices: string[]; qty: number } | undefined;
    let triggerSatisfied = false;

    const qtyOf = (n: string): number => cart.get(n) ?? 0;
    const priceOf = (n: string): number => itemMap.get(n)?.priceFils ?? 0;

    const grantInvoiceOrFree = (): void => {
      if (reward.kind === 'DISCOUNT' && reward.appliesTo === 'INVOICE') {
        invoiceDiscountFils += this.discountAmount(reward, subtotalFils);
      } else if (reward.kind === 'FREE_ITEM') {
        for (const it of reward.items ?? []) {
          freeItems.push({ itemNumber: it.itemNumber, qty: it.qty });
        }
      } else if (reward.kind === 'FREE_ITEM_CHOICE') {
        freeItemChoice = { choices: reward.choices ?? [], qty: reward.qty ?? 1 };
      }
    };

    switch (offer.type) {
      case 'ITEM_QTY_DISCOUNT': {
        const item = String(t.itemNumber ?? '');
        const minQty = Number(t.minQty ?? 0);
        if (item && qtyOf(item) >= minQty) {
          triggerSatisfied = true;
          if (reward.kind === 'DISCOUNT') {
            const gross = roundFils(qtyOf(item) * priceOf(item));
            this.addLineDiscount(
              lineDiscounts,
              item,
              this.discountAmount(reward, gross),
            );
          }
        }
        break;
      }
      case 'BUY_X_GET_Y_FREE': {
        const item = String(t.itemNumber ?? '');
        const buyQty = Number(t.qty ?? 0);
        const times = buyQty > 0 ? Math.floor(qtyOf(item) / buyQty) : 0;
        if (item && times >= 1 && reward.kind === 'FREE_ITEM') {
          triggerSatisfied = true;
          for (const it of reward.items ?? []) {
            freeItems.push({ itemNumber: it.itemNumber, qty: it.qty * times });
          }
        }
        break;
      }
      case 'BASKET_THRESHOLD': {
        const set = (t.itemNumbers as string[]) ?? [];
        const count = set.reduce((s, n) => s + qtyOf(n), 0);
        if (count >= Number(t.minItemCount ?? 0)) {
          triggerSatisfied = true;
          grantInvoiceOrFree();
        }
        break;
      }
      case 'ITEM_SET_THRESHOLD': {
        const set = (t.itemNumbers as string[]) ?? [];
        const total = set.reduce((s, n) => s + qtyOf(n), 0);
        const presentCount = set.filter((n) => qtyOf(n) > 0).length;
        const minTotal = Number(t.minTotalQty ?? 0);
        const ok =
          t.match === 'ALL'
            ? presentCount === set.length && total >= minTotal
            : presentCount > 0 && total >= minTotal;
        if (ok) {
          triggerSatisfied = true;
          if (reward.kind === 'DISCOUNT' && reward.appliesTo === 'SET') {
            for (const n of set) {
              const gross = roundFils(qtyOf(n) * priceOf(n));
              if (gross > 0) {
                this.addLineDiscount(
                  lineDiscounts,
                  n,
                  this.discountAmount(reward, gross),
                );
              }
            }
          } else {
            grantInvoiceOrFree();
          }
        }
        break;
      }
      case 'LOYALTY_FIRST_PURCHASE': {
        // Eligibility (new customer) is gated by the caller.
        triggerSatisfied = true;
        grantInvoiceOrFree();
        break;
      }
    }

    const lineDiscTotal = [...lineDiscounts.values()].reduce((s, n) => s + n, 0);
    const freeValue = freeItems.reduce(
      (s, f) => s + roundFils(f.qty * priceOf(f.itemNumber)),
      0,
    );
    return {
      triggerSatisfied,
      lineDiscounts,
      invoiceDiscountFils,
      freeItems,
      freeItemChoice,
      discountFils: lineDiscTotal + invoiceDiscountFils + freeValue,
    };
  }

  private discountAmount(reward: DiscountReward, baseFils: number): number {
    if (reward.discountType === 'PERCENT') {
      return roundFils((baseFils * (reward.value ?? 0)) / 100);
    }
    // VALUE is already in fils; never exceed the base it applies to.
    return Math.min(roundFils(reward.value ?? 0), baseFils);
  }

  private addLineDiscount(
    map: Map<string, number>,
    itemNumber: string,
    fils: number,
  ): void {
    map.set(itemNumber, (map.get(itemNumber) ?? 0) + fils);
  }

  // ---- gating ----

  private isWithinSchedule(offer: Offer, at: Date): boolean {
    if (offer.validFrom && at < new Date(offer.validFrom)) return false;
    if (offer.validTo && at > new Date(offer.validTo)) return false;
    if (offer.daysOfWeek?.length && !offer.daysOfWeek.includes(at.getDay())) {
      return false;
    }
    if (offer.timeFrom || offer.timeTo) {
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(
        at.getMinutes(),
      ).padStart(2, '0')}`;
      if (offer.timeFrom && hhmm < offer.timeFrom) return false;
      if (offer.timeTo && hhmm > offer.timeTo) return false;
    }
    return true;
  }

  private isEligible(
    eligibility: OfferEligibility | undefined,
    customer: Customer | null,
    ctx: EvaluationContext,
    isNew: boolean,
  ): boolean {
    const e = eligibility ?? { customerScope: 'ALL' as const };
    switch (e.customerScope) {
      case 'ALL':
        break;
      case 'SEGMENT':
        if (!customer || !e.segments?.includes(customer.category ?? '')) {
          return false;
        }
        break;
      case 'SPECIFIC':
        if (!customer || !e.customerNumbers?.includes(customer.customerNumber)) {
          return false;
        }
        break;
      case 'NEW_ONLY':
        if (!customer || !isNew) return false;
        break;
    }
    if (e.regionIds?.length) {
      if (!customer?.regionId || !e.regionIds.includes(customer.regionId)) {
        return false;
      }
    }
    if (e.repIds?.length) {
      const rep = ctx.repId ?? customer?.repId ?? null;
      if (!rep || !e.repIds.includes(rep)) return false;
    }
    if (e.storeNumbers?.length) {
      if (!ctx.storeNumber || !e.storeNumbers.includes(ctx.storeNumber)) {
        return false;
      }
    }
    return true;
  }

  /** True when the customer has no prior posted-or-draft SALE voucher. */
  async isNewCustomer(
    customerNumber: string,
    excludeVoucherNumber?: string,
  ): Promise<boolean> {
    const qb = this.vouchersRepo
      .createQueryBuilder('v')
      .where('v.customerNumber = :c', { c: customerNumber })
      .andWhere("v.transKind = 'SALE'");
    if (excludeVoucherNumber) {
      qb.andWhere('v.voucherNumber != :ex', { ex: excludeVoucherNumber });
    }
    return (await qb.getCount()) === 0;
  }

  // ---- loaders / helpers ----

  private toCartMap(lines: CartLineInput[]): Map<string, number> {
    const cart = new Map<string, number>();
    for (const l of lines) {
      cart.set(l.itemNumber, (cart.get(l.itemNumber) ?? 0) + l.qty);
    }
    return cart;
  }

  private async loadItems(
    cart: Map<string, number>,
    offers: Offer[],
  ): Promise<Map<string, ItemInfo>> {
    const numbers = new Set<string>(cart.keys());
    for (const o of offers) {
      if (o.reward?.kind === 'FREE_ITEM') {
        for (const it of o.reward.items ?? []) numbers.add(it.itemNumber);
      }
    }
    if (!numbers.size) return new Map();
    const items = await this.itemsRepo.find({
      where: { itemNumber: In([...numbers]) },
    });
    return new Map(
      items.map((i) => [
        i.itemNumber,
        {
          priceFils: i.price ?? 0,
          taxPct: Number(i.taxPercentage ?? 0),
          name: i.nameEn || i.name,
        },
      ]),
    );
  }

  private async loadPerCustomerCounts(
    offers: Offer[],
    ctx: EvaluationContext,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!ctx.customerNumber || !offers.some((o) => o.perCustomerLimit != null)) {
      return counts;
    }
    const rows = await this.redemptionsRepo
      .createQueryBuilder('r')
      .select('r.offerId', 'offerId')
      .addSelect('COUNT(*)', 'cnt')
      .where('r.customerNumber = :c', { c: ctx.customerNumber })
      .groupBy('r.offerId')
      .getRawMany<{ offerId: string; cnt: string }>();
    for (const row of rows) counts.set(row.offerId, Number(row.cnt));
    return counts;
  }

  private summarize(offer: Offer, itemMap: Map<string, ItemInfo>): string {
    const name = (n: string): string => itemMap.get(n)?.name ?? n;
    const t = offer.trigger as Record<string, unknown>;
    const r = offer.reward;
    const discountText = (): string => {
      if (r.kind !== 'DISCOUNT') return '';
      return r.discountType === 'PERCENT'
        ? `${r.value}% off`
        : `${(r.value ?? 0) / 1000} JOD off`;
    };
    const freeText = (): string =>
      r.kind === 'FREE_ITEM'
        ? (r.items ?? []).map((i) => `${i.qty}× ${name(i.itemNumber)} free`).join(' + ')
        : r.kind === 'FREE_ITEM_CHOICE'
          ? `${r.qty}× free (choice of ${(r.choices ?? []).length})`
          : '';

    switch (offer.type) {
      case 'ITEM_QTY_DISCOUNT':
        return `Buy ${t.minQty}× ${name(String(t.itemNumber))} → ${discountText()}`;
      case 'BUY_X_GET_Y_FREE':
        return `Buy ${t.qty}× ${name(String(t.itemNumber))} → ${freeText()}`;
      case 'BASKET_THRESHOLD':
        return `${t.minItemCount}+ items from set → ${r.kind === 'DISCOUNT' ? discountText() + ' invoice' : freeText()}`;
      case 'ITEM_SET_THRESHOLD':
        return `${t.minTotalQty}+ qty across set (${t.match}) → ${r.kind === 'DISCOUNT' ? discountText() : freeText()}`;
      case 'LOYALTY_FIRST_PURCHASE':
        return `New customer first purchase → ${r.kind === 'DISCOUNT' ? discountText() + ' invoice' : freeText()}`;
      default:
        return offer.name;
    }
  }
}
