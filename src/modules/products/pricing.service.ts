import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { PriceRule } from './entities/price-rule.entity';
import { CustomerPrice } from './entities/customer-price.entity';
import { PriceListItem } from './entities/price-list-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CustomerAiProfile } from '../customers/entities/customer-ai-profile.entity';

export interface PriceQuote {
  productId: string;
  qty: number;
  segment: string | null;
  listUnitPrice: number; // fils
  appliedRuleId: string | null;
  discountPct: number;
  finalUnitPrice: number; // fils
  lineTotal: number; // fils
  /** CONTRACT (ERP customer price) | PRICE_RULE (segment) | BASE. */
  priceSource?: string;
}

/**
 * The tier of a price list that applies to this quantity, today.
 *
 * Deliberately the ERP's own rule, from `findBestPriceListItem` in its pricing
 * engine: keep every band whose quantity and date window match, then take the
 * one with the HIGHEST minQty — the most specific tier — rather than the
 * cheapest. Those are not the same answer. The mirror used to store only the
 * cheapest band, so a list reading "1-9 → 1.000, 10+ → 0.900" sold a single unit
 * at 0.900.
 *
 * An inactive band never prices, matching the ERP's per-item switch.
 */
export function pickPriceListTier<
  T extends {
    minQty: number;
    maxQty?: number | null;
    startDate?: string | null;
    endDate?: string | null;
    isActive?: boolean;
  },
>(tiers: T[], qty: number, on: Date): T | null {
  // Compared as 'YYYY-MM-DD' strings, which is how a `date` column reads back.
  // Building Dates from them would drag the server's timezone into the answer
  // and could move a boundary day by one.
  const today = on.toISOString().slice(0, 10);
  const applicable = tiers.filter((t) => {
    if (t.isActive === false) return false;
    if (t.startDate && today < t.startDate) return false;
    if (t.endDate && today > t.endDate) return false;
    const min = Number(t.minQty) || 1;
    if (qty < min) return false;
    if (t.maxQty != null && qty > Number(t.maxQty)) return false;
    return true;
  });
  if (!applicable.length) return null;
  applicable.sort((a, b) => (Number(b.minQty) || 1) - (Number(a.minQty) || 1));
  return applicable[0];
}

@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(ItemCart)
    private readonly products: Repository<ItemCart>,
    @InjectRepository(PriceRule)
    private readonly rules: Repository<PriceRule>,
    @InjectRepository(CustomerPrice)
    private readonly customerPrices: Repository<CustomerPrice>,
    @InjectRepository(PriceListItem)
    private readonly priceListItems: Repository<PriceListItem>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(CustomerAiProfile)
    private readonly aiProfiles: Repository<CustomerAiProfile>,
  ) {}

  /**
   * Effective price for (product, qty, optional customer). Picks the rule that
   * yields the lowest final unit price among all applicable rules.
   */
  async quote(
    productId: string,
    qty: number,
    customerId?: string,
  ): Promise<PriceQuote> {
    const product = await this.products.findOne({ where: { id: productId } });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    let segment: string | null = null;
    if (customerId) {
      const profile = await this.aiProfiles.findOne({ where: { customerId } });
      segment = profile?.segment ?? null;
    }

    // ERP-mirrored customer contract price takes precedence over segment rules.
    if (customerId) {
      // The ERP models each unit of a product as its OWN sku (حبة and طرد are two
      // rows), which the item pull folds into one cash-van item plus item_units.
      // So a customer can hold several contract rows that all carry this itemId,
      // and a bare findOne returned whichever the database happened to hand back
      // first — a carton price could be quoted for a single piece.
      //
      // This entry point asks about the item in its BASE unit (there is no unit
      // in the request), so prefer the row with no unit attached and fall back to
      // the cheapest remaining one. Deterministic either way, and never dearer
      // than what the merchant already agreed.
      const contracts = await this.customerPrices.find({
        where: { customerId, itemId: productId },
      });
      const contract =
        contracts.find((c) => !c.itemUnitId) ??
        contracts.sort((a, b) => a.unitPrice - b.unitPrice)[0];
      if (contract) {
        const listUnit = product.price;
        return {
          productId,
          qty,
          segment,
          listUnitPrice: listUnit,
          appliedRuleId: null,
          discountPct:
            listUnit > 0 ? Math.round((1 - contract.unitPrice / listUnit) * 1000) / 10 : 0,
          finalUnitPrice: contract.unitPrice,
          lineTotal: contract.unitPrice * qty,
          priceSource: contract.priceSource ?? 'CONTRACT',
        };
      }

      // Then the customer's assigned price list (below a per-customer override).
      const cust = await this.customers.findOne({ where: { id: customerId } });
      if (cust?.priceListId) {
        const tiers = await this.priceListItems.find({
          where: { priceListId: cust.priceListId, itemId: productId },
        });
        const pli = pickPriceListTier(tiers, qty, new Date());
        if (pli) {
          const listUnit = product.price;
          return {
            productId,
            qty,
            segment,
            listUnitPrice: listUnit,
            appliedRuleId: null,
            discountPct:
              listUnit > 0 ? Math.round((1 - pli.unitPrice / listUnit) * 1000) / 10 : 0,
            finalUnitPrice: pli.unitPrice,
            lineTotal: pli.unitPrice * qty,
            priceSource: 'PRICE_LIST',
          };
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const candidates = await this.rules
      .createQueryBuilder('r')
      .where('r.deleted_at IS NULL')
      .andWhere('(r.product_id = :pid OR r.product_id IS NULL)', { pid: productId })
      .andWhere('(r.customer_segment = :seg OR r.customer_segment IS NULL)', {
        seg: segment ?? '__none__',
      })
      .andWhere('r.min_qty <= :qty', { qty })
      .andWhere('(r.valid_from IS NULL OR r.valid_from <= :today)', { today })
      .andWhere('(r.valid_to IS NULL OR r.valid_to >= :today)', { today })
      .getMany();

    const listUnit = product.price;
    let best: { ruleId: string | null; discountPct: number; finalUnit: number } = {
      ruleId: null,
      discountPct: 0,
      finalUnit: listUnit,
    };

    for (const r of candidates) {
      // A segment-specific rule must actually match the resolved segment.
      if (r.customerSegment && r.customerSegment !== segment) continue;
      const finalUnit =
        r.fixedPrice != null
          ? r.fixedPrice
          : Math.round(listUnit * (1 - r.discountPct / 100));
      if (finalUnit < best.finalUnit) {
        best = {
          ruleId: r.id,
          discountPct:
            r.fixedPrice != null
              ? listUnit > 0
                ? Math.round((1 - r.fixedPrice / listUnit) * 1000) / 10
                : 0
              : r.discountPct,
          finalUnit,
        };
      }
    }

    return {
      productId,
      qty,
      segment,
      listUnitPrice: listUnit,
      appliedRuleId: best.ruleId,
      discountPct: best.discountPct,
      finalUnitPrice: best.finalUnit,
      lineTotal: best.finalUnit * qty,
      priceSource: best.ruleId ? 'PRICE_RULE' : 'BASE',
    };
  }
}
