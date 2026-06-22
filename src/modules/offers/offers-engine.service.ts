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
  EvaluatedLine,
  EvaluationContext,
  EvaluationResult,
  FreeItemSpec,
  FreeLine,
  GiftReward,
  ItemPercentDiscountReward,
  ItemSetTrigger,
  LinePercentDiscountReward,
  OfferEligibility,
  PaymentMethodTrigger,
  PaymentType,
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

/**
 * The discount engine. Stateless w.r.t. the cart: given lines + context it loads
 * the active offers and computes per-line discounts. All money is integer fils.
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
    const itemCount = [...cart.values()].reduce((s, q) => s + q, 0);

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
      (o) => o.eligibility?.customerScope === 'NEW_ONLY',
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

      const outcome = this.computeReward(
        offer,
        cart,
        itemMap,
        subtotalFils,
        itemCount,
        ctx.paymentMethod ?? null,
        ctx.chosenFreeItems ?? null,
      );
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
        summary: this.summarize(offer),
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
    const grandTotalFils =
      netBeforeInvoiceDiscount + taxFils - clampedInvoiceDiscount;

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

  // ---- reward computation (pure) ----

  private computeReward(
    offer: Offer,
    cart: Map<string, number>,
    itemMap: Map<string, ItemInfo>,
    subtotalFils: number,
    itemCount: number,
    paymentMethod: PaymentType | null,
    chosenFreeItems: string[] | null,
  ): RewardOutcome {
    const lineDiscounts = new Map<string, number>();
    const freeItems: FreeItemSpec[] = [];
    let freeItemChoice: { choices: string[]; qty: number } | undefined;
    let triggerSatisfied = false;
    const priceOf = (n: string): number => itemMap.get(n)?.priceFils ?? 0;

    if (offer.type === 'PAYMENT_METHOD_DISCOUNT') {
      const t = offer.trigger as PaymentMethodTrigger;
      const reward = offer.reward as LinePercentDiscountReward;
      const isCredit = paymentMethod === 'CREDIT';
      const paymentOk =
        t.paymentCondition === 'CREDIT' ? isCredit : !isCredit;
      const totalOk =
        t.minOrderTotal == null || subtotalFils >= t.minOrderTotal;
      const countOk = t.minItemCount == null || itemCount >= t.minItemCount;

      if (
        paymentOk &&
        totalOk &&
        countOk &&
        reward?.kind === 'LINE_PERCENT_DISCOUNT'
      ) {
        triggerSatisfied = true;
        const pct = this.effectivePercent(reward, itemCount);
        if (pct > 0) {
          for (const [n, q] of cart) {
            const gross = roundFils(q * priceOf(n));
            if (gross > 0) {
              this.addLineDiscount(
                lineDiscounts,
                n,
                roundFils((gross * pct) / 100),
              );
            }
          }
        }
      }
    } else if (offer.type === 'ITEM_QTY_REWARD') {
      const t = offer.trigger as ItemSetTrigger;
      const items = t.itemNumbers ?? [];
      // Combined qty of the selected items in the cart.
      const qty = items.reduce((s, n) => s + (cart.get(n) ?? 0), 0);
      const reward = offer.reward;

      if (reward?.kind === 'GIFT') {
        const tier = this.bestGiftTier(reward, qty);
        if (tier && tier.freeQty > 0) {
          triggerSatisfied = true;
          freeItemChoice = { choices: reward.giftItems, qty: tier.freeQty };
          // Resolve the rep's picks (∩ pool, up to freeQty) into free lines.
          const picks = (chosenFreeItems ?? [])
            .filter((i) => reward.giftItems.includes(i))
            .slice(0, tier.freeQty);
          for (const itemNumber of picks) {
            freeItems.push({ itemNumber, qty: 1 });
          }
        }
      } else if (reward?.kind === 'ITEM_PERCENT_DISCOUNT') {
        if (qty >= reward.minQty) {
          triggerSatisfied = true;
          const pct = this.effectivePercent(reward, qty);
          if (pct > 0) {
            for (const n of items) {
              const gross = roundFils((cart.get(n) ?? 0) * priceOf(n));
              if (gross > 0) {
                this.addLineDiscount(
                  lineDiscounts,
                  n,
                  roundFils((gross * pct) / 100),
                );
              }
            }
          }
        }
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
      invoiceDiscountFils: 0,
      freeItems,
      freeItemChoice,
      discountFils: lineDiscTotal + freeValue,
    };
  }

  /** Highest gift tier whose minQty is met by the combined selected-item qty. */
  private bestGiftTier(
    reward: GiftReward,
    qty: number,
  ): { minQty: number; freeQty: number } | null {
    let best: { minQty: number; freeQty: number } | null = null;
    for (const tier of reward.tiers ?? []) {
      if (qty >= tier.minQty && (!best || tier.minQty > best.minQty)) {
        best = tier;
      }
    }
    return best;
  }

  /**
   * The effective percent for a percentage reward given a quantity:
   *   base × (1 + multiplier × floor(qty / itemsPerStep))
   * STATIC ignores the multiplier. Capped at maxPercent and never above 100.
   */
  private effectivePercent(
    reward: Pick<
      LinePercentDiscountReward,
      'basePercent' | 'mode' | 'multiplier' | 'itemsPerStep' | 'maxPercent'
    >,
    itemCount: number,
  ): number {
    const steps =
      reward.mode === 'DYNAMIC' && reward.itemsPerStep
        ? Math.floor(itemCount / reward.itemsPerStep)
        : 0;
    const pct = reward.basePercent * (1 + (reward.multiplier ?? 0) * steps);
    const cap = Math.min(reward.maxPercent ?? 100, 100);
    return Math.max(0, Math.min(pct, cap));
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

  /** True when the customer has no prior SALE voucher. */
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
    // Gift pools need prices too (the free line is the item at its real price).
    for (const o of offers) {
      if (o.reward?.kind === 'GIFT') {
        for (const g of (o.reward as GiftReward).giftItems ?? []) numbers.add(g);
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

  private summarize(offer: Offer): string {
    if (offer.type === 'ITEM_QTY_REWARD') {
      const items = (offer.trigger as ItemSetTrigger).itemNumbers ?? [];
      const r = offer.reward;
      const on = items.join('/');
      if (r?.kind === 'GIFT') {
        const tiers = (r.tiers ?? [])
          .slice()
          .sort((a, b) => a.minQty - b.minQty)
          .map((t) => `${t.minQty}→${t.freeQty}`)
          .join(', ');
        return `Buy ${on} → gift (${tiers}) from ${r.giftItems.length} items`;
      }
      if (r?.kind === 'ITEM_PERCENT_DISCOUNT') {
        const base =
          r.mode === 'DYNAMIC'
            ? `${r.basePercent}%→${r.maxPercent ?? r.basePercent}% dynamic`
            : `${r.basePercent}%`;
        return `Buy ${r.minQty}× ${on} → ${base} off those items`;
      }
      return offer.name;
    }
    const t = offer.trigger as PaymentMethodTrigger;
    const r = offer.reward as LinePercentDiscountReward;
    const cond = t.paymentCondition === 'CREDIT' ? 'Credit' : 'Cash';
    const mins: string[] = [];
    if (t.minOrderTotal) mins.push(`≥ ${(t.minOrderTotal / 1000).toFixed(3)} JOD`);
    if (t.minItemCount) mins.push(`≥ ${t.minItemCount} items`);
    const suffix = mins.length ? ` (${mins.join(', ')})` : '';
    if (r?.mode === 'DYNAMIC') {
      const cap = r.maxPercent != null ? ` up to ${r.maxPercent}%` : '';
      return `${cond} · ${r.basePercent}% per line, ×${r.multiplier ?? 0} per ${
        r.itemsPerStep ?? '?'
      } items${cap}${suffix}`;
    }
    return `${cond} · ${r?.basePercent ?? 0}% off each line${suffix}`;
  }
}
