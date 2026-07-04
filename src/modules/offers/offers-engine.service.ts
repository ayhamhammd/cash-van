import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { roundFils } from '../../common/utils/currency.util';
import { ItemCart } from '../items/entities/item-cart.entity';
import { Customer } from '../customers/entities/customer.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
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
  ItemAmountDiscountReward,
  ItemPercentDiscountReward,
  ItemSetTrigger,
  LineOfferRef,
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
    @InjectRepository(AppSettings)
    private readonly settingsRepo: Repository<AppSettings>,
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
      {
        qty: number;
        unitPriceFils: number;
        taxPct: number;
        discountFils: number;
        offers: LineOfferRef[];
      }
    >();
    for (const [itemNumber, qty] of cart) {
      const info = itemMap.get(itemNumber);
      work.set(itemNumber, {
        qty,
        unitPriceFils: info?.priceFils ?? 0,
        taxPct: info?.taxPct ?? 0,
        discountFils: 0,
        offers: [],
      });
    }
    const subtotalFils = [...work.values()].reduce(
      (s, l) => s + roundFils(l.qty * l.unitPriceFils),
      0,
    );

    const freeLines: FreeLine[] = [];
    const appliedOffers: AppliedOffer[] = [];
    const invoiceDiscountFils = 0; // no invoice-level offers in the current model

    // ── Classify eligible, trigger-satisfied offers by category ────────────────
    // Conflict rule: within a category (payment-method vs item) the HIGHEST
    // discount wins per line; across categories the discounts ADD on the line.
    const isCredit = (ctx.paymentMethod ?? null) === 'CREDIT';
    interface Disc {
      offer: Offer;
      pct: number;
      /** Amount-off per unit (fils) for ITEM_AMOUNT_DISCOUNT; undefined = percent. */
      amountPerUnitFils?: number;
      items: Set<string> | null; // null = applies to every line (payment-method)
    }
    const payOffers: Disc[] = [];
    const itemOffers: Disc[] = [];
    const gifts: { offer: Offer; reward: GiftReward; freeQty: number }[] = [];

    for (const offer of offers) {
      if (!this.isWithinSchedule(offer, at)) continue;
      if (!this.isEligible(offer.eligibility, customer, ctx, isNew)) continue;
      if (
        offer.totalRedemptionLimit != null &&
        offer.redemptionCount >= offer.totalRedemptionLimit
      )
        continue;
      if (
        offer.perCustomerLimit != null &&
        (perCustomerCounts.get(offer.id) ?? 0) >= offer.perCustomerLimit
      )
        continue;

      if (offer.type === 'PAYMENT_METHOD_DISCOUNT') {
        const t = offer.trigger as PaymentMethodTrigger;
        const reward = offer.reward as LinePercentDiscountReward;
        const payOk = t.paymentCondition === 'CREDIT' ? isCredit : !isCredit;
        const totalOk = t.minOrderTotal == null || subtotalFils >= t.minOrderTotal;
        const countOk = t.minItemCount == null || itemCount >= t.minItemCount;
        if (payOk && totalOk && countOk && reward?.kind === 'LINE_PERCENT_DISCOUNT') {
          // Base applies at minItemCount; steps accrue per itemsPerStep above it.
          const pct = this.effectivePercent(reward, itemCount, t.minItemCount ?? 0);
          if (pct > 0) payOffers.push({ offer, pct, items: null });
        }
      } else if (offer.type === 'ITEM_QTY_REWARD') {
        const t = offer.trigger as ItemSetTrigger;
        const items = t.itemNumbers ?? [];
        const qty = items.reduce((s, n) => s + (cart.get(n) ?? 0), 0);
        const reward = offer.reward;
        if (reward?.kind === 'GIFT') {
          const freeQty = this.giftFreeQty(reward, qty);
          if (freeQty > 0) gifts.push({ offer, reward, freeQty });
        } else if (reward?.kind === 'ITEM_PERCENT_DISCOUNT') {
          if (qty >= reward.minQty) {
            // Base applies at minQty; steps accrue per itemsPerStep above it.
            const pct = this.effectivePercent(reward, qty, reward.minQty ?? 0);
            if (pct > 0) itemOffers.push({ offer, pct, items: new Set(items) });
          }
        } else if (reward?.kind === 'ITEM_AMOUNT_DISCOUNT') {
          if (qty >= reward.minQty) {
            // Same stepping as the percent twin, but the base is fils-per-unit.
            const amt = this.effectiveAmount(reward, qty, reward.minQty ?? 0);
            if (amt > 0) {
              itemOffers.push({
                offer,
                pct: 0,
                amountPerUnitFils: amt,
                items: new Set(items),
              });
            }
          }
        }
      }
    }

    // Highest payment-method offer — its % is the same on every line, so a single
    // global winner serves all lines.
    const bestPay = payOffers.reduce<Disc | null>(
      (b, c) => (!b || c.pct > b.pct ? c : b),
      null,
    );

    // ── Per line: (best payment % + best item % for that line), clamped ────────
    const contrib = new Map<string, number>(); // offerId → discount fils contributed
    for (const [itemNumber, l] of work) {
      const gross = roundFils(l.qty * l.unitPriceFils);
      if (gross <= 0) continue;
      // A candidate's discount for this line: percent → % of gross; amount →
      // per-unit fils × line qty. The highest fils wins (mixing kinds is fine).
      const discFor = (c: Disc): number =>
        c.amountPerUnitFils != null
          ? roundFils(l.qty * c.amountPerUnitFils)
          : roundFils((gross * c.pct) / 100);
      let bestItem: Disc | null = null;
      let bestItemFils = 0;
      for (const c of itemOffers) {
        if (!c.items!.has(itemNumber)) continue;
        const d = discFor(c);
        if (!bestItem || d > bestItemFils) {
          bestItem = c;
          bestItemFils = d;
        }
      }
      let payFils = bestPay ? roundFils((gross * bestPay.pct) / 100) : 0;
      let itemFils = bestItem ? bestItemFils : 0;
      if (payFils > gross) payFils = gross;
      if (payFils + itemFils > gross) itemFils = gross - payFils; // never below 0
      l.discountFils = payFils + itemFils;
      if (bestPay && payFils > 0) {
        contrib.set(bestPay.offer.id, (contrib.get(bestPay.offer.id) ?? 0) + payFils);
        l.offers.push({
          offerId: bestPay.offer.id,
          name: bestPay.offer.name,
          pct: bestPay.pct,
          discountFils: payFils,
        });
      }
      if (bestItem && itemFils > 0) {
        contrib.set(bestItem.offer.id, (contrib.get(bestItem.offer.id) ?? 0) + itemFils);
        l.offers.push({
          offerId: bestItem.offer.id,
          name: bestItem.offer.name,
          pct: bestItem.pct,
          discountFils: itemFils,
        });
      }
    }

    // ── Gifts → free lines (rep picks resolved from chosenFreeItems) ───────────
    const giftValue = new Map<string, number>();
    for (const g of gifts) {
      const picks = (ctx.chosenFreeItems ?? [])
        .filter((i) => g.reward.giftItems.includes(i))
        .slice(0, g.freeQty);
      for (const itemNumber of picks) {
        const priceFils = itemMap.get(itemNumber)?.priceFils ?? 0;
        freeLines.push({ itemNumber, qty: 1, unitPriceFils: priceFils, offerId: g.offer.id });
        giftValue.set(g.offer.id, (giftValue.get(g.offer.id) ?? 0) + priceFils);
      }
    }

    // ── Applied-offers summary (discount contributors + gift offers) ───────────
    const appliedIds = new Set<string>([
      ...contrib.keys(),
      ...gifts.map((g) => g.offer.id),
    ]);
    for (const offer of offers) {
      if (!appliedIds.has(offer.id)) continue;
      const gift = gifts.find((g) => g.offer.id === offer.id);
      const picked = gift
        ? (ctx.chosenFreeItems ?? [])
            .filter((i) => gift.reward.giftItems.includes(i))
            .slice(0, gift.freeQty)
            .map((itemNumber) => ({ itemNumber, qty: 1 }))
        : [];
      appliedOffers.push({
        offerId: offer.id,
        name: offer.name,
        type: offer.type,
        summary: this.summarize(offer),
        discountFils: (contrib.get(offer.id) ?? 0) + (giftValue.get(offer.id) ?? 0),
        freeItems: picked,
        freeItemChoice: gift
          ? { choices: gift.reward.giftItems, qty: gift.freeQty }
          : undefined,
      });
    }

    // Honour the company tax mode (mirrors the ERP): INCLUSIVE prices already
    // contain tax (extract it, don't add on top), EXCLUSIVE adds it on top. Same
    // rule as the voucher calc + the app's LocalOfferEvaluator — otherwise the
    // sale screen shows tax added on top even for an inclusive-priced company.
    const settingsRow = await this.settingsRepo.findOne({ where: { id: 1 } });
    const taxInclusive = settingsRow?.taxCalcMethod === 'INCLUSIVE';

    // Clamp per-line discount to the line gross, then build the response.
    const resultLines: EvaluatedLine[] = [];
    let lineDiscountTotal = 0;
    let taxFils = 0;
    for (const [itemNumber, l] of work) {
      const gross = roundFils(l.qty * l.unitPriceFils);
      const discount = Math.min(l.discountFils, gross);
      const net = gross - discount;
      lineDiscountTotal += discount;
      taxFils += taxInclusive
        ? net - (l.taxPct > 0 ? roundFils((net * 100) / (100 + l.taxPct)) : net)
        : roundFils(net * (l.taxPct / 100));
      resultLines.push({
        itemNumber,
        qty: l.qty,
        unitPriceFils: l.unitPriceFils,
        lineDiscountFils: discount,
        lineNetFils: net,
        offers: l.offers,
      });
    }

    const netBeforeInvoiceDiscount = subtotalFils - lineDiscountTotal;
    const clampedInvoiceDiscount = Math.min(
      invoiceDiscountFils,
      netBeforeInvoiceDiscount,
    );
    // INCLUSIVE: tax is already inside the net, so the grand total is just the
    // net (tax is reported for information). EXCLUSIVE: tax is added on top.
    const grandTotalFils =
      netBeforeInvoiceDiscount +
      (taxInclusive ? 0 : taxFils) -
      clampedInvoiceDiscount;

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

  /** Free-gift count: one per `itemsPerGift` bought, capped at `maxFreeQty`. */
  private giftFreeQty(reward: GiftReward, qty: number): number {
    if (!reward.itemsPerGift || reward.itemsPerGift < 1) return 0;
    const perStep =
      reward.giftsPerStep && reward.giftsPerStep > 0 ? reward.giftsPerStep : 1;
    const n = Math.floor(qty / reward.itemsPerGift) * perStep;
    return reward.maxFreeQty != null ? Math.min(n, reward.maxFreeQty) : n;
  }

  /**
   * The effective percent for a percentage reward given a quantity. The base
   * percent applies at the offer's threshold (`anchor` — minItemCount for a
   * payment offer, minQty for an item offer); each full `itemsPerStep` ABOVE the
   * anchor adds one multiplier step:
   *   steps = floor(max(0, count − anchor) / itemsPerStep)
   *   pct   = base × (1 + multiplier × steps)
   * So at exactly the threshold you get the base rate (not base × 2). STATIC
   * ignores the multiplier. Capped at maxPercent and never above 100.
   */
  private effectivePercent(
    reward: Pick<
      LinePercentDiscountReward,
      'basePercent' | 'mode' | 'multiplier' | 'itemsPerStep' | 'maxPercent'
    >,
    count: number,
    anchor = 0,
  ): number {
    const steps =
      reward.mode === 'DYNAMIC' && reward.itemsPerStep
        ? Math.floor(Math.max(0, count - anchor) / reward.itemsPerStep)
        : 0;
    const pct = reward.basePercent * (1 + (reward.multiplier ?? 0) * steps);
    const cap = Math.min(reward.maxPercent ?? 100, 100);
    return Math.max(0, Math.min(pct, cap));
  }

  /**
   * The effective per-unit amount (fils) for an amount-off reward — the fils twin
   * of {@link effectivePercent}. Base applies at `minQty`; each full `itemsPerStep`
   * above it adds one multiplier step. STATIC ignores the multiplier. Capped at
   * `maxAmountFils` (no natural upper bound otherwise); the per-line clamp to the
   * line gross still prevents a negative net.
   */
  private effectiveAmount(
    reward: Pick<
      ItemAmountDiscountReward,
      'baseAmountFils' | 'mode' | 'multiplier' | 'itemsPerStep' | 'maxAmountFils'
    >,
    count: number,
    anchor = 0,
  ): number {
    const steps =
      reward.mode === 'DYNAMIC' && reward.itemsPerStep
        ? Math.floor(Math.max(0, count - anchor) / reward.itemsPerStep)
        : 0;
    const amt = reward.baseAmountFils * (1 + (reward.multiplier ?? 0) * steps);
    const cap = reward.maxAmountFils ?? Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(amt, cap));
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
        const cap = r.maxFreeQty != null ? ` (max ${r.maxFreeQty})` : '';
        const per = r.giftsPerStep && r.giftsPerStep > 1 ? `${r.giftsPerStep} gifts` : '1 gift';
        return `Buy ${on}: ${per} / ${r.itemsPerGift} bought${cap}, from ${r.giftItems.length} items`;
      }
      if (r?.kind === 'ITEM_PERCENT_DISCOUNT') {
        const base =
          r.mode === 'DYNAMIC'
            ? `${r.basePercent}%→${r.maxPercent ?? r.basePercent}% dynamic`
            : `${r.basePercent}%`;
        return `Buy ${r.minQty}× ${on} → ${base} off those items`;
      }
      if (r?.kind === 'ITEM_AMOUNT_DISCOUNT') {
        const jod = (fils: number): string => (fils / 1000).toFixed(3);
        const base =
          r.mode === 'DYNAMIC'
            ? `${jod(r.baseAmountFils)}→${jod(r.maxAmountFils ?? r.baseAmountFils)} JOD dynamic`
            : `${jod(r.baseAmountFils)} JOD`;
        return `Buy ${r.minQty}× ${on} → ${base} off each unit`;
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
