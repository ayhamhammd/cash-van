import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { PriceRule } from './entities/price-rule.entity';
import { CustomerPrice } from './entities/customer-price.entity';
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

@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(ItemCart)
    private readonly products: Repository<ItemCart>,
    @InjectRepository(PriceRule)
    private readonly rules: Repository<PriceRule>,
    @InjectRepository(CustomerPrice)
    private readonly customerPrices: Repository<CustomerPrice>,
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
      const contract = await this.customerPrices.findOne({
        where: { customerId, itemId: productId },
      });
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
