import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { VoucherHeader } from './entities/voucher-header.entity';
import { VoucherTransaction } from './entities/voucher-transaction.entity';
import { Payment } from './entities/payment.entity';
import { PaymentCheque } from './entities/payment-cheque.entity';
import { TransactionKind } from './entities/transaction-kind.entity';
import { VanStock } from '../products/entities/van-stock.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { TobaccoTaxProfile } from '../items/entities/tobacco-tax-profile.entity';
import { User } from '../users/entities/user.entity';
import { Rep } from '../reps/entities/rep.entity';

import {
  CreateVoucherDto,
  VoucherLineDto,
} from './dto/create-voucher.dto';
import { ListVouchersQueryDto } from './dto/list-vouchers-query.dto';
import { UserContextService } from '../../common/context/user-context.service';
import { CustomerProximityService } from '../customers/customer-proximity.service';
import { OffersService } from '../offers/offers.service';
import { OffersEngineService } from '../offers/offers-engine.service';
import { SettingsService } from '../settings/settings.service';
import { calcVoucher, toFils, filsToJod, type TaxMode } from './voucher-calc';
import { calculateTobaccoTax, type TobaccoTaxProfileData } from './tobacco-tax-calc';
import type { EvaluationResult } from '../offers/offers.types';

/** Resolved tobacco context for one voucher line (null = not a tobacco line). */
interface TobaccoLineCtx {
  profile: TobaccoTaxProfileData;
  /** Consumer price per BASE piece, integer fils. */
  consumerPerPieceFils: number;
}

/** Map a stored tobacco profile row to the pure engine's profile shape. */
function toEngineProfile(p: TobaccoTaxProfile): TobaccoTaxProfileData {
  return {
    id: p.id,
    taxBase: p.taxBase,
    salesTaxEnabled: p.salesTaxEnabled,
    salesTaxRate: p.salesTaxRate,
    specialTaxEnabled: p.specialTaxEnabled,
    specialTaxCalculationType: p.specialTaxCalculationType,
    specialTaxBase: p.specialTaxBase,
    specialTaxRate: p.specialTaxRate ?? null,
    specialTaxFixedAmount: p.specialTaxFixedAmount ?? null,
    withheldTaxEnabled: p.withheldTaxEnabled,
    withheldTaxCalculationType: p.withheldTaxCalculationType,
    withheldTaxBase: p.withheldTaxBase,
    withheldTaxAmount: p.withheldTaxAmount ?? null,
    withheldTaxRate: p.withheldTaxRate ?? null,
  };
}

/**
 * How each voucher kind moves the salesman's van stock when posted:
 *   in      → quantity += qty   (TRANSFER_IN, RETURN)
 *   out     → quantity -= qty   (SALE, TRANSFER_OUT)
 *   reserve → reserved += qty   (ORDER — committed; shipped on fulfilment)
 * Anything else (PURCHASE, PAYMENT_*, ADJUSTMENT) does not touch the van.
 */
const VAN_EFFECT: Record<string, 'in' | 'out' | 'reserve'> = {
  SALE: 'out',
  TRANSFER_OUT: 'out',
  RETURN: 'in',
  RETURN_IN: 'in',
  TRANSFER_IN: 'in',
  ORDER: 'reserve',
};

/**
 * Header trans_kind for a stock-to-stock transfer. Each of its lines moves qty
 * out of `fromStoreNumber` and into `toStoreNumber` in a single voucher — no
 * separate IN voucher needed.
 */
const TRANSFER_KIND = 'TRANSFER';

/** Voucher-number prefix per kind (SALE → INV …). Fallback: first 3 letters. */
const VOUCHER_PREFIX: Record<string, string> = {
  SALE: 'INV',
  RETURN: 'RET',
  ORDER: 'ORD',
  VENDOR_RETURN: 'VRT',
  PURCHASE: 'PUR',
  IN: 'IN',
  OUT: 'OUT',
  TRANSFER: 'TRF',
  TRANSFER_IN: 'TIN',
  TRANSFER_OUT: 'TOUT',
  ADJUSTMENT: 'ADJ',
  PAYMENT_IN: 'RCV',
  PAYMENT_OUT: 'PAY',
};
import { CreateChequeDto } from './dto/create-cheque.dto';


/** Permission keys gating sensitive salesman actions (F10). */
export const PERM_RETURN_DIRECT = 'vouchers.return.direct';
/** May create returns at all (off → no returns). */
export const PERM_RETURN_CREATE = 'vouchers.return.create';
/** When set (with create), each return needs admin approval before it posts. */
export const PERM_RETURN_APPROVAL = 'vouchers.return.approval';
export const PERM_DISCOUNT_DIRECT = 'vouchers.discount.direct';
/** May enter a discount, but it requires admin approval (blocks save until approved). */
export const PERM_DISCOUNT_APPROVAL = 'vouchers.discount.approval';
export const PERM_PRICE_OVERRIDE = 'vouchers.priceOverride';
/** Prefix key encoding the max direct-discount %, e.g. "vouchers.discount.max:5". */
export const PERM_DISCOUNT_MAX_PREFIX = 'vouchers.discount.max:';

/**
 * Canonical transaction kinds the app relies on. Ensured on every startup so a
 * fresh/clean DB can always create SALE/RETURN/ORDER/… vouchers (and mirror them
 * to the ERP) — no manual seed needed. Insert-only (never clobbers a curated row).
 */
const STANDARD_TRANS_KINDS: ReadonlyArray<{
  transKind: string;
  transName: string;
  sign: number;
}> = [
  { transKind: 'SALE', transName: 'بيع', sign: -1 },
  { transKind: 'RETURN', transName: 'مرتجع', sign: 1 },
  { transKind: 'ORDER', transName: 'طلبية', sign: 0 },
  { transKind: 'TRANSFER_IN', transName: 'تحميل المركبة', sign: 1 },
  { transKind: 'TRANSFER_OUT', transName: 'تنزيل المركبة', sign: -1 },
  { transKind: 'TRANSFER', transName: 'تحويل بين المخازن', sign: 0 },
  { transKind: 'IN', transName: 'إدخال للمخزن', sign: 1 },
  { transKind: 'OUT', transName: 'إخراج من المخزن', sign: -1 },
  { transKind: 'PURCHASE', transName: 'شراء', sign: 1 },
  { transKind: 'VENDOR_RETURN', transName: 'مرتجع مورد', sign: -1 },
  { transKind: 'ADJUSTMENT', transName: 'تسوية', sign: 0 },
  { transKind: 'PAYMENT_IN', transName: 'سند قبض', sign: 0 },
  { transKind: 'PAYMENT_OUT', transName: 'سند صرف', sign: 0 },
];

@Injectable()
export class VouchersService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(VoucherHeader)
    private readonly headersRepo: Repository<VoucherHeader>,
    @InjectRepository(PaymentCheque)
    private readonly chequesRepo: Repository<PaymentCheque>,
    private readonly userCtx: UserContextService,
    private readonly proximity: CustomerProximityService,
    private readonly events: EventEmitter2,
    private readonly offers: OffersService,
    private readonly offersEngine: OffersEngineService,
    private readonly settings: SettingsService,
  ) {}

  private readonly logger = new Logger(VouchersService.name);

  /**
   * Ensure the standard transaction kinds always exist (insert-only, idempotent).
   * Without this a clean DB throws "Unknown trans_kind: SALE" on the first sale.
   */
  async onModuleInit(): Promise<void> {
    try {
      const res = await this.dataSource
        .getRepository(TransactionKind)
        .createQueryBuilder()
        .insert()
        .values([...STANDARD_TRANS_KINDS])
        .orIgnore() // ON CONFLICT DO NOTHING — never overwrites a curated row
        .execute();
      const added = res.identifiers.filter(Boolean).length;
      if (added) this.logger.log(`Seeded ${added} missing transaction kind(s)`);
    } catch (e) {
      this.logger.warn(
        `Could not ensure transaction kinds: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async create(dto: CreateVoucherDto): Promise<VoucherHeader> {
    // F10 gate: salesmen need explicit permission for returns, discounts and
    // price overrides — otherwise the client must file an approval request
    // (the approving manager re-runs create() under their own role). Runs BEFORE
    // offers so system-granted offer discounts bypass the manual-discount gate.
    await this.enforceSalesmanPolicy(dto);
    // Location lock: a rep flagged customers.requireProximity may only act on a
    // customer while within the geofence of its saved location (and seeds a
    // missing one from repLat/repLng). No-op for everyone else. Runs before any
    // stock/offer work so an out-of-range action never mutates anything.
    await this.proximity.enforce({
      customerNumber: dto.customerNumber,
      repLat: dto.repLat,
      repLng: dto.repLng,
    });
    // Server-authoritative offers: bake per-line discounts and gift free-lines
    // into the dto BEFORE the voucher is built, so gifts post as real lines and
    // their stock moves. MUST run before createUnchecked (was previously dead
    // code after an early return, so offers never applied on posted sales).
    const offerResult = await this.applyOffers(dto);
    const result = await this.createUnchecked(dto);
    await this.recordOfferRedemptions(result, offerResult);
    // Mirror posted vouchers to the ERP (ErpSync listener filters by kind + enqueues
    // an outbox push; no-op when ERP off). Stock IN/OUT adjustments aren't mirrored.
    if (result.isPosted) {
      this.events.emit('erp.voucher.posted', {
        voucherNumber: result.voucherNumber,
        transKind: result.transKind,
      });
    }
    return result;
  }

  /**
   * Server-authoritative offer application (SALE only). Re-evaluates active offers
   * against the cart and bakes the result into the dto BEFORE the voucher is
   * built: per-line discounts (added to discountValue), the invoice discount
   * (added to the header discount), and free lines (appended as 100%-discount
   * transactions, net 0). The applied offer ids are stamped on the dto so the
   * client can never under- or over-claim. Best-effort and fully guarded — any
   * failure leaves the sale exactly as the client sent it (offers never block a
   * sale). Returns the evaluation when something applied, else null.
   *
   * Money: the engine works in integer fils off each item's DB price; vouchers
   * use major-unit decimal strings — we translate fils → JOD (÷1000) so the
   * posted voucher matches exactly what /offers/evaluate previewed.
   */
  private async applyOffers(
    dto: CreateVoucherDto,
  ): Promise<EvaluationResult | null> {
    if (dto.transKind !== 'SALE' || !dto.transactions?.length) return null;
    try {
      const cart = dto.transactions.map((l) => ({
        itemNumber: l.itemNumber,
        qty: Number(l.itemQty) || 0,
      }));
      const result = await this.offersEngine.evaluate(cart, {
        customerNumber: dto.customerNumber ?? null,
        // Payment method drives PAYMENT_METHOD_DISCOUNT. A sale carries one
        // payment line; default to CASH when none was sent.
        paymentMethod: dto.payments?.[0]?.paymentType ?? 'CASH',
        // Rep's gift picks for ITEM_QTY_REWARD → resolved to free lines.
        chosenFreeItems: dto.chosenFreeItems ?? null,
        at: dto.inDate ? new Date(dto.inDate) : undefined,
      });
      if (!result.appliedOffers.length) return null;

      // 1) per-line discounts (fils → JOD, added to any manual discountValue).
      for (const l of result.lines) {
        if (l.lineDiscountFils <= 0) continue;
        const target = dto.transactions.find(
          (t) => t.itemNumber === l.itemNumber,
        );
        if (!target) continue;
        const existing = Number(target.discountValue ?? 0);
        target.discountValue = (existing + l.lineDiscountFils / 1000).toFixed(3);
      }

      // 2) invoice-level discount → header discount.
      if (result.invoiceDiscountFils > 0) {
        const existing = Number(dto.totalDiscountValue ?? 0);
        dto.totalDiscountValue = (
          existing +
          result.invoiceDiscountFils / 1000
        ).toFixed(3);
      }

      // 3) free lines → appended as their own line at real price, 100% discount.
      // The engine emits one qty-1 line per gift pick; merge them by item so the
      // same gift posts as a single "× N" line (like the paid lines) instead of N
      // repeated rows.
      if (result.freeLines.length) {
        const names = await this.loadItemNames(
          result.freeLines.map((f) => f.itemNumber),
        );
        const saleStore = dto.transactions.find((t) => t.storeNumber)
          ?.storeNumber;
        const merged = new Map<
          string,
          { itemNumber: string; unitPriceFils: number; qty: number }
        >();
        for (const f of result.freeLines) {
          const m = merged.get(f.itemNumber);
          if (m) m.qty += f.qty;
          else
            merged.set(f.itemNumber, {
              itemNumber: f.itemNumber,
              unitPriceFils: f.unitPriceFils,
              qty: f.qty,
            });
        }
        for (const f of merged.values()) {
          dto.transactions.push({
            itemNumber: f.itemNumber,
            itemName: names.get(f.itemNumber) ?? f.itemNumber,
            itemQty: String(f.qty),
            unitPrice: (f.unitPriceFils / 1000).toFixed(3),
            discountPercentage: '100',
            discountValue: '0',
            unitBaseQty: 1,
            storeNumber: saleStore,
          });
        }
      }

      // 4) stamp the applied offer ids (server is authoritative).
      dto.appliedOfferIds = result.appliedOffers.map((o) => o.offerId);
      return result;
    } catch (err) {
      this.logger.warn(
        `Offer application skipped for voucher: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async loadItemNames(
    itemNumbers: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(itemNumbers)];
    if (!unique.length) return new Map();
    const items = await this.dataSource
      .getRepository(ItemCart)
      .find({ where: { itemNumber: In(unique) } });
    // Prefer the Arabic name so gift lines read the same as the paid lines the app
    // sends (e.g. "مياه 1.5 لتر", not the English "Water 1.5L").
    return new Map(
      items.map((i) => [i.itemNumber, i.nameAr ?? i.name ?? i.itemNumber]),
    );
  }

  /**
   * Best-effort redemption recording from the server's own evaluation. Runs
   * AFTER the sale committed and is fully guarded — a failure is logged and
   * swallowed so it can never roll back or block a sale.
   */
  private async recordOfferRedemptions(
    header: VoucherHeader,
    result: EvaluationResult | null,
  ): Promise<void> {
    if (!result || !result.appliedOffers.length) return;
    try {
      await this.offers.recordApplied({
        voucherNumber: header.voucherNumber,
        customerNumber: header.customerNumber ?? null,
        applied: result.appliedOffers.map((o) => ({
          offerId: o.offerId,
          discountFils: o.discountFils,
          freeItems: o.freeItems,
        })),
      });
    } catch (err) {
      this.logger.warn(
        `Offer redemption recording failed for voucher ${header.voucherNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Resolve each voucher line's tobacco context (aligned 1:1 with dto.transactions).
   * Returns all-null when the feature is off / not a SALE. A tobacco item that is
   * missing its profile or consumer price fails fast (can't sell an unconfigured
   * tobacco item). Only active profiles are honored.
   */
  private async resolveTobaccoLines(
    em: EntityManager,
    dto: CreateVoucherDto,
    items: ItemCart[],
    enabled: boolean,
  ): Promise<(TobaccoLineCtx | null)[]> {
    const empty = dto.transactions.map(() => null as TobaccoLineCtx | null);
    if (!enabled) return empty;

    const itemByNumber = new Map(items.map((i) => [i.itemNumber, i]));
    const tobaccoItems = items.filter((i) => i.isTobaccoProduct);
    if (tobaccoItems.length === 0) return empty;

    const profileIds = [
      ...new Set(
        tobaccoItems
          .map((i) => i.tobaccoTaxProfileId)
          .filter((x): x is string => !!x),
      ),
    ];
    const profiles = profileIds.length
      ? await em.getRepository(TobaccoTaxProfile).find({
          where: { id: In(profileIds), isActive: true },
        })
      : [];
    const profileById = new Map(profiles.map((p) => [p.id, p]));

    return dto.transactions.map((line) => {
      const item = itemByNumber.get(line.itemNumber);
      if (!item || !item.isTobaccoProduct) return null;
      if (!item.tobaccoTaxProfileId) {
        throw new BadRequestException(
          `Tobacco item ${item.itemNumber} has no tobacco tax profile assigned`,
        );
      }
      const profileRow = profileById.get(item.tobaccoTaxProfileId);
      if (!profileRow) {
        throw new BadRequestException(
          `Tobacco item ${item.itemNumber}: tax profile is missing or inactive`,
        );
      }
      if (item.consumerPriceFils == null) {
        throw new BadRequestException(
          `Tobacco item ${item.itemNumber} has no consumer price set`,
        );
      }
      return {
        profile: toEngineProfile(profileRow),
        consumerPerPieceFils: item.consumerPriceFils,
      };
    });
  }

  private async createUnchecked(dto: CreateVoucherDto): Promise<VoucherHeader> {
    return this.dataSource.transaction(async (em) => {
      const tk = await this.loadTransKind(em, dto.transKind);
      const isTransferVoucher = dto.transKind === TRANSFER_KIND;

      // A RETURN must reference its original SALE voucher; its lines must be
      // items from that sale and go back into the SAME store the sale left from.
      // (Runs before number generation so the return's store is known.)
      const referenceVoucherNumber = dto.referenceVoucherNumber ?? null;
      if (dto.transKind === 'RETURN') {
        if (!referenceVoucherNumber) {
          throw new BadRequestException(
            'A RETURN must reference the original SALE voucher (referenceVoucherNumber)',
          );
        }
        const sale = await em.getRepository(VoucherHeader).findOne({
          where: { voucherNumber: referenceVoucherNumber },
          relations: { transactions: true },
        });
        if (!sale) {
          throw new NotFoundException(
            `Sale voucher ${referenceVoucherNumber} not found`,
          );
        }
        if (sale.transKind !== 'SALE') {
          throw new BadRequestException(
            `Voucher ${referenceVoucherNumber} is not a SALE`,
          );
        }
        const saleStoreByItem = new Map<string, string | null>();
        for (const t of sale.transactions ?? []) {
          saleStoreByItem.set(
            t.itemNumber,
            t.fromStoreNumber ?? t.storeNumber ?? null,
          );
        }
        for (const line of dto.transactions) {
          if (!saleStoreByItem.has(line.itemNumber)) {
            throw new BadRequestException(
              `Item ${line.itemNumber} is not on sale voucher ${referenceVoucherNumber}`,
            );
          }
          line.storeNumber =
            saleStoreByItem.get(line.itemNumber) ?? line.storeNumber;
        }
      }

      // Auto-generate a serial voucher number when not supplied. Keyed off the
      // STORE the voucher affects: <prefix>-<storeNumber><6-digit serial>.
      if (!dto.voucherNumber || !dto.voucherNumber.trim()) {
        const sLine = dto.transactions.find(
          (l) => l.storeNumber || l.fromStoreNumber || l.toStoreNumber,
        );
        const store =
          sLine?.storeNumber ??
          sLine?.fromStoreNumber ??
          sLine?.toStoreNumber ??
          'NA';
        dto.voucherNumber = await this.nextVoucherNumber(em, dto.transKind, store);
      }
      const dup = await em.getRepository(VoucherHeader).exist({
        where: { voucherNumber: dto.voucherNumber },
      });
      if (dup) {
        throw new ConflictException(
          `Voucher ${dto.voucherNumber} already exists`,
        );
      }

      // Tax is ALWAYS taken from the item record (DB), never trusted from the
      // client — overwrite each line's taxPercentage with the item's own rate.
      const itemNumbers = [...new Set(dto.transactions.map((l) => l.itemNumber))];
      let items: ItemCart[] = [];
      if (itemNumbers.length) {
        items = await em.getRepository(ItemCart).find({
          where: { itemNumber: In(itemNumbers) },
        });
        const taxByItem = new Map(items.map((i) => [i.itemNumber, i.taxPercentage]));
        for (const line of dto.transactions) {
          const tax = taxByItem.get(line.itemNumber);
          if (tax !== undefined && tax !== null) line.taxPercentage = String(tax);
        }
      }

      this.validateLines(dto.transactions);
      const settingsView = await this.settings.get().catch(() => null);
      const taxMode: TaxMode =
        settingsView?.taxCalcMethod === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';

      // ── Tobacco tax resolution (SALE only, when the master toggle is ON) ──────
      // For a tobacco line, normal GST is BYPASSED (calc runs it at 0%) and the
      // tobacco NET tax is added on top afterwards. Resolve each line's profile
      // now so an unconfigured tobacco item fails fast. Aligned 1:1 with lines.
      const tobaccoEnabled = settingsView?.tobaccoTaxEnabled === true && dto.transKind === 'SALE';
      const tobaccoLines = await this.resolveTobaccoLines(em, dto, items, tobaccoEnabled);

      // Canonical money engine (voucher-calc.ts) — fils-integer tax + discount in
      // the seller's INCLUSIVE/EXCLUSIVE mode. Line discount = % + value (stacked);
      // ONE header discount (% or value) distributed across lines PRE-tax. This is
      // the single spec the app + ERP conform to (docs/VOUCHER-CALC-SPEC.md).
      const calc = calcVoucher({
        taxMode,
        headerDiscountPct: Number(dto.totalDiscountPercentage ?? 0) || 0,
        headerDiscountFils: toFils(dto.totalDiscountValue ?? 0),
        lines: dto.transactions.map((l, i) => ({
          unitPriceFils: toFils(l.unitPrice),
          qty: Number(l.itemQty) || 0,
          lineDiscountPct: Number(l.discountPercentage ?? 0) || 0,
          lineDiscountFils: toFils(l.discountValue ?? 0),
          // Tobacco lines: GST bypassed (net tobacco tax replaces it, added on top).
          taxRatePct: tobaccoLines[i] ? 0 : Number(l.taxPercentage ?? 0) || 0,
        })),
      });

      // Per-line tobacco tax (fils). Computed on base pieces so per-piece excise
      // is correct; base = qtyOfUnit × unitBaseQty, unit/consumer prices per piece.
      const tobaccoResults = dto.transactions.map((line, i) => {
        const ctx = tobaccoLines[i];
        if (!ctx) return null;
        const unitFactor = line.unitBaseQty && line.unitBaseQty > 0 ? line.unitBaseQty : 1;
        const baseQty = (Number(line.itemQty) || 0) * unitFactor;
        return calculateTobaccoTax({
          quantity: baseQty,
          unitPrice: Math.round(toFils(line.unitPrice) / unitFactor),
          consumerPrice: ctx.consumerPerPieceFils,
          profile: ctx.profile,
        });
      });
      const tobaccoTaxTotalFils = tobaccoResults.reduce((s, r) => s + (r?.netTaxAmount ?? 0), 0);

      // Per-line results aligned 1:1 with dto.transactions.
      const computed = dto.transactions.map((line, i) => ({ line, res: calc.lines[i] }));

      const header = em.getRepository(VoucherHeader).create({
        voucherNumber: dto.voucherNumber,
        transKind: dto.transKind,
        userCode: dto.userCode,
        customerNumber: dto.customerNumber ?? null,
        vendorNumber: dto.vendorNumber ?? null,
        referenceVoucherNumber,
        inDate: dto.inDate ? new Date(dto.inDate) : new Date(),
        total: filsToJod(calc.totalNetFils), // net (tax base)
        totalTax: filsToJod(calc.totalTaxFils + tobaccoTaxTotalFils), // GST + tobacco net
        netTotal: filsToJod(calc.grandTotalFils + tobaccoTaxTotalFils), // grand total (with tax)
        totalDiscountValue: filsToJod(calc.headerDiscountFils),
        totalDiscountPercentage: (dto.totalDiscountPercentage ?? '0').toString(),
        appliedOfferIds: dto.appliedOfferIds ?? [],
        isPosted: dto.isPosted ?? false,
        isEdit: false,
      });
      await em.getRepository(VoucherHeader).save(header);

      // Resolve each line's sign from its OWN trans_kind (falling back to the
      // header), caching lookups so a multi-line voucher hits the DB once/kind.
      const signCache = new Map<string, number>([[tk.transKind, tk.sign]]);
      const resolveSign = async (kind: string): Promise<number> => {
        if (!signCache.has(kind)) {
          signCache.set(kind, (await this.loadTransKind(em, kind)).sign);
        }
        return signCache.get(kind)!;
      };

      // First pass: resolve each line's stock movement (qty in base pieces).
      const prepared = [];
      for (const { line, res } of computed) {
        const lineKind = line.transKind ?? dto.transKind;
        const unitFactor =
          line.unitBaseQty && line.unitBaseQty > 0 ? line.unitBaseQty : 1;
        const qtyOfUnit = Number(line.itemQty);
        const baseQty = qtyOfUnit * unitFactor;
        const sign = await resolveSign(lineKind);
        const move = this.resolveStockMovement(line, baseQty, sign, isTransferVoucher);
        prepared.push({ line, res, lineKind, unitFactor, qtyOfUnit, baseQty, move });
      }

      // Don't allow a sale/out/transfer-out to drive a store's stock negative.
      const need = new Map<string, number>();
      for (const p of prepared) {
        if (p.move.fromStoreNumber) {
          const key = `${p.line.itemNumber} ${p.move.fromStoreNumber}`;
          need.set(key, (need.get(key) ?? 0) + p.baseQty);
        }
      }
      for (const [key, qty] of need) {
        const sep = key.indexOf(' ');
        const itemNumber = key.slice(0, sep);
        const store = key.slice(sep + 1);
        const available = await this.stockBalance(em, itemNumber, store);
        if (available < qty) {
          throw new BadRequestException(
            `Not enough stock of ${itemNumber} in store ${store}: have ${available}, need ${qty}`,
          );
        }
      }

      const txEntities = prepared.map((p, i) => {
        const tob = tobaccoResults[i];
        const ctx = tobaccoLines[i];
        return em.getRepository(VoucherTransaction).create({
          voucherNumber: dto.voucherNumber,
          itemNumber: p.line.itemNumber,
          itemName: p.line.itemName,
          transKind: p.lineKind,
          storeNumber: p.move.storeNumber,
          fromStoreNumber: p.move.fromStoreNumber,
          toStoreNumber: p.move.toStoreNumber,
          // Tobacco lines carry NO GST rate (the tobacco rate lives in the snapshot).
          taxPercentage: tob ? '0' : p.line.taxPercentage ?? '0',
          discountPercentage: p.line.discountPercentage ?? '0',
          // RESOLVED total line discount = own line discount + its share of the
          // header discount (fils). This is exactly what the ERP push needs.
          discountValue: filsToJod(p.res.lineDiscountFils + p.res.headerShareFils),
          itemQty: p.baseQty.toString(),
          unitPrice: (p.line.unitPrice ?? '0').toString(),
          qtyOfUnit: p.qtyOfUnit.toString(),
          unitCode: p.line.unitCode ?? null,
          unitName: p.line.unitName ?? null,
          unitBaseQty: p.unitFactor,
          signedQty: p.move.signedQty.toString(),
          total: filsToJod(p.res.netFils), // line net (tax base, post-discount)
          // Tobacco line total = discounted net + tobacco NET tax (added on top);
          // otherwise the GST-inclusive line total from the money engine.
          netTotal: filsToJod(tob ? p.res.netFils + tob.netTaxAmount : p.res.totalFils),
          // ── Tobacco snapshot (frozen at sale time) ──────────────────────────
          isTobaccoLine: tob !== null,
          tobaccoTaxProfileId: ctx?.profile.id ?? null,
          consumerPriceFils: tob ? ctx!.consumerPerPieceFils : null,
          consumerValueFils: tob?.consumerValue ?? null,
          tobaccoTaxBaseFils: tob?.taxBaseAmount ?? null,
          tobaccoSalesTaxRate: ctx?.profile.salesTaxRate ?? null,
          tobaccoSalesTaxFils: tob?.salesTaxAmount ?? 0,
          tobaccoSpecialTaxCalcType: ctx?.profile.specialTaxCalculationType ?? null,
          tobaccoSpecialTaxRate: ctx?.profile.specialTaxRate ?? null,
          tobaccoSpecialTaxFixedFils: ctx?.profile.specialTaxFixedAmount ?? null,
          tobaccoSpecialTaxFils: tob?.specialTaxAmount ?? 0,
          tobaccoWithheldTaxCalcType: ctx?.profile.withheldTaxCalculationType ?? null,
          tobaccoWithheldTaxRate: ctx?.profile.withheldTaxRate ?? null,
          tobaccoWithheldTaxFixedFils: ctx?.profile.withheldTaxAmount ?? null,
          tobaccoWithheldTaxFils: tob?.withheldTaxAmount ?? 0,
          tobaccoGrossTaxFils: tob?.grossTaxAmount ?? 0,
          tobaccoNetTaxFils: tob?.netTaxAmount ?? 0,
          tobaccoCalcDetails: tob
            ? (tob.calculationDetails as unknown as Record<string, unknown>)
            : null,
        });
      });
      await em.getRepository(VoucherTransaction).save(txEntities);

      if (dto.payments?.length) {
        const payments = dto.payments.map((p) =>
          em.getRepository(Payment).create({
            voucherNumber: dto.voucherNumber,
            amount: p.amount,
            paymentDate: p.paymentDate ? new Date(p.paymentDate) : new Date(),
            fromAcc: p.fromAcc ?? null,
            toAcc: p.toAcc ?? null,
            paymentType: p.paymentType,
          }),
        );
        await em.getRepository(Payment).save(payments);
      }

      return em.getRepository(VoucherHeader).findOneOrFail({
        where: { id: header.id },
        relations: { transactions: true, payments: true },
      });
    });
  }

  /**
   * Post a voucher: lock it and reflect its lines on the salesman's van stock
   * (out for SALE/TRANSFER_OUT, in for RETURN/TRANSFER_IN, reserve for ORDER).
   */
  async post(id: string): Promise<VoucherHeader> {
    const result = await this.dataSource.transaction(async (em) => {
      const header = await em.getRepository(VoucherHeader).findOne({
        where: { id },
        relations: { transactions: true },
      });
      if (!header) throw new NotFoundException(`Voucher ${id} not found`);
      if (header.isPosted) {
        throw new ConflictException('Voucher already posted');
      }
      header.isPosted = true;
      await em.getRepository(VoucherHeader).save(header);

      const effect = VAN_EFFECT[header.transKind];
      if (effect) {
        const rep = await this.resolveRep(em, header.userCode);
        if (rep) {
          for (const line of header.transactions ?? []) {
            await this.applyLineToVan(em, rep.id, line, effect);
          }
        }
      }

      return em.getRepository(VoucherHeader).findOneOrFail({
        where: { id },
        relations: { transactions: true, payments: true },
      });
    });
    // Mirror to the ERP now that it's posted — same as create()'s posted path.
    // Critical for the create-then-post flows (TRANSFER, and any draft posted
    // later), which would otherwise never reach the ERP outbox.
    this.events.emit('erp.voucher.posted', {
      voucherNumber: result.voucherNumber,
      transKind: result.transKind,
    });
    return result;
  }

  /**
   * Fulfil an ORDER: release its reservation and ship the goods from the van
   * (reserved -= qty, quantity -= qty). Idempotent via `is_fulfilled`.
   */
  async fulfill(id: string): Promise<VoucherHeader> {
    return this.dataSource.transaction(async (em) => {
      const header = await em.getRepository(VoucherHeader).findOne({
        where: { id },
        relations: { transactions: true },
      });
      if (!header) throw new NotFoundException(`Voucher ${id} not found`);
      if (header.transKind !== 'ORDER') {
        throw new BadRequestException('Only ORDER vouchers can be fulfilled');
      }
      if (!header.isPosted) {
        throw new BadRequestException('Post the order before fulfilling it');
      }
      if (header.isFulfilled) {
        throw new ConflictException('Order already fulfilled');
      }

      const rep = await this.resolveRep(em, header.userCode);
      if (rep) {
        for (const line of header.transactions ?? []) {
          const product = await em
            .getRepository(ItemCart)
            .findOne({ where: { itemNumber: line.itemNumber } });
          if (!product) continue;
          const vs = await em.getRepository(VanStock).findOne({
            where: { repId: rep.id, productId: product.id },
          });
          if (!vs) continue;
          const qty = Math.round(Number(line.itemQty) || 0);
          vs.reserved = Math.max(0, vs.reserved - qty);
          vs.quantity = Math.max(0, vs.quantity - qty);
          vs.snapshotAt = new Date();
          await em.getRepository(VanStock).save(vs);
        }
      }

      header.isFulfilled = true;
      await em.getRepository(VoucherHeader).save(header);
      return em.getRepository(VoucherHeader).findOneOrFail({
        where: { id },
        relations: { transactions: true, payments: true },
      });
    });
  }

  /** Resolve the rep (van owner) behind a voucher's userCode. */
  private async resolveRep(
    em: EntityManager,
    userCode: string,
  ): Promise<Rep | null> {
    const user = await em
      .getRepository(User)
      .findOne({ where: { userNumber: userCode } });
    if (!user) return null;
    return em.getRepository(Rep).findOne({ where: { userId: user.id } });
  }

  /** Apply a single line to the rep's van_stock row (upserting it). */
  private async applyLineToVan(
    em: EntityManager,
    repId: string,
    line: VoucherTransaction,
    effect: 'in' | 'out' | 'reserve',
  ): Promise<void> {
    const product = await em
      .getRepository(ItemCart)
      .findOne({ where: { itemNumber: line.itemNumber } });
    if (!product) return; // unknown product → nothing to move
    const qty = Math.round(Number(line.itemQty) || 0);
    if (qty <= 0) return;

    const repo = em.getRepository(VanStock);
    const vs =
      (await repo.findOne({ where: { repId, productId: product.id } })) ??
      repo.create({ repId, productId: product.id, quantity: 0, reserved: 0 });

    if (effect === 'in') vs.quantity += qty;
    else if (effect === 'out') vs.quantity = Math.max(0, vs.quantity - qty);
    else if (effect === 'reserve') vs.reserved += qty;

    vs.snapshotAt = new Date();
    if (effect === 'in') vs.loadedAt = new Date();
    await repo.save(vs);
  }

  async update(
    id: string,
    patch: Partial<Pick<VoucherHeader, 'totalDiscountValue' | 'totalDiscountPercentage' | 'customerNumber' | 'vendorNumber'>>,
  ): Promise<VoucherHeader> {
    const header = await this.findOneOrThrow(id);
    if (header.isPosted) {
      throw new ForbiddenException('Cannot edit a posted voucher');
    }
    Object.assign(header, patch, { isEdit: true });
    return this.headersRepo.save(header);
  }

  async findOneOrThrow(id: string): Promise<VoucherHeader> {
    const header = await this.headersRepo.findOne({
      where: { id },
      relations: { transactions: true, payments: true },
    });
    if (!header) {
      throw new NotFoundException(`Voucher ${id} not found`);
    }
    return header;
  }

  async list(
    q: ListVouchersQueryDto = {},
  ): Promise<
    Array<VoucherHeader & { storeNumber: string | null; customerName: string | null }>
  > {
    const qb = this.headersRepo
      .createQueryBuilder('h')
      .leftJoin(
        'voucher_transactions',
        'vt',
        'vt.voucher_number = h.voucher_number',
      )
      .leftJoin('customers', 'cust', 'cust.customer_number = h.customer_number')
      .addSelect(
        'MIN(COALESCE(vt.store_number, vt.from_store_number, vt.to_store_number))',
        'storeNumber',
      )
      .addSelect('MIN(COALESCE(cust.name_ar, cust.name_en))', 'customerName')
      .groupBy('h.id')
      .orderBy('h.in_date', 'DESC');

    if (q.transKind) {
      // Accept a single kind or a comma list (SALE,RETURN,ORDER) for the
      // Operations hub sub-tabs.
      const kinds = q.transKind
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      if (kinds.length === 1) {
        qb.andWhere('h.trans_kind = :tk', { tk: kinds[0] });
      } else if (kinds.length > 1) {
        qb.andWhere('h.trans_kind IN (:...tks)', { tks: kinds });
      }
    }
    if (q.userCode) qb.andWhere('h.user_code = :uc', { uc: q.userCode });
    if (q.customerNumber)
      qb.andWhere('h.customer_number = :cn', { cn: q.customerNumber });
    if (q.voucherNumber)
      qb.andWhere('h.voucher_number = :vn', { vn: q.voucherNumber });
    if (q.dateFrom) qb.andWhere('h.in_date >= :df', { df: q.dateFrom });
    if (q.dateTo) qb.andWhere('h.in_date < (:dt::date + 1)', { dt: q.dateTo });
    if (q.store) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM voucher_transactions s
           WHERE s.voucher_number = h.voucher_number
             AND :st IN (s.store_number, s.from_store_number, s.to_store_number))`,
        { st: q.store },
      );
    }

    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((e, i) => ({
      ...e,
      storeNumber: (raw[i]?.storeNumber as string | null) ?? null,
      customerName: (raw[i]?.customerName as string | null) ?? null,
    }));
  }

  async remove(id: string): Promise<void> {
    const header = await this.findOneOrThrow(id);
    if (header.isPosted) {
      throw new ForbiddenException('Cannot delete a posted voucher');
    }
    await this.headersRepo.softDelete(id);
  }

  // ---- Cheques --------------------------------------------------------------

  createCheque(dto: CreateChequeDto): Promise<PaymentCheque> {
    return this.chequesRepo.save(this.chequesRepo.create(dto));
  }

  listCheques(): Promise<PaymentCheque[]> {
    return this.chequesRepo.find({ order: { dueDate: 'ASC' } });
  }

  async removeCheque(id: string): Promise<void> {
    const res = await this.chequesRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Cheque ${id} not found`);
    }
  }

  // ---- helpers --------------------------------------------------------------

  /**
   * Decide which stock(s) a line moves and the legacy signed_qty:
   *   - TRANSFER line → out of fromStore, into toStore (both required, distinct)
   *   - sign < 0 (SALE/…) → out of the line's store
   *   - sign > 0 (RETURN/…) → into the line's store
   *   - sign = 0 (ORDER/PAYMENT/ADJUSTMENT) → no stock movement
   * signedQty is kept for backward compatibility; the item_balance view now
   * reads from_store_number/to_store_number, so transfers carry signedQty = 0.
   */
  /**
   * Preview the next voucher number WITHOUT consuming the sequence — peeks
   * `last_value`/`is_called` so the dashboard can show the real number before
   * saving. The created voucher gets this same number (single-cashier safe).
   */
  /**
   * Consume the next serial for (kind, store) and return it — used by the sync
   * inbox to hand the mobile app an authoritative number at intake, so a client
   * can never choose a colliding number.
   */
  async reserveVoucherNumber(transKind: string, store: string): Promise<string> {
    return this.dataSource.transaction((em) =>
      this.nextVoucherNumber(em, transKind, store),
    );
  }

  /** The store number of a rep's van (rep.van_id → warehouse) — null if unlinked. */
  async resolveRepVanStore(repId: string): Promise<string | null> {
    const rows: Array<{ wh_number: string }> = await this.dataSource.query(
      `SELECT w.wh_number FROM reps r
         JOIN warehouses w ON w.id = r.van_id
        WHERE r.id = $1 AND r.van_id IS NOT NULL
        LIMIT 1`,
      [repId],
    );
    return rows[0]?.wh_number ?? null;
  }

  async previewVoucherNumber(
    transKind: string,
    store: string,
  ): Promise<{ voucherNumber: string }> {
    const rows: Array<{ last_number: string }> = await this.dataSource.query(
      `SELECT last_number FROM voucher_counters WHERE store_number = $1 AND trans_kind = $2`,
      [store, transKind],
    );
    const next = (rows[0] ? Number(rows[0].last_number) : 0) + 1;
    const seq = String(next).padStart(6, '0');
    const prefix =
      VOUCHER_PREFIX[transKind] ?? transKind.slice(0, 3).toUpperCase();
    return { voucherNumber: `${prefix}-${store}${seq}` };
  }

  /**
   * Next serial number for THIS store + kind (a separate sequence per pair),
   * atomically incremented via an upsert on `voucher_counters`.
   * Format: <prefix>-<storeNumber><6-digit serial>.
   */
  private async nextVoucherNumber(
    em: EntityManager,
    transKind: string,
    store: string,
  ): Promise<string> {
    const prefix = VOUCHER_PREFIX[transKind] ?? transKind.slice(0, 3).toUpperCase();
    // Bump the per-(store,kind) counter and skip any number that already exists
    // (e.g. older client-numbered vouchers), so we always return the true
    // next-available number and never collide.
    for (let attempt = 0; attempt < 1000; attempt++) {
      const rows: Array<{ last_number: string }> = await em.query(
        `INSERT INTO voucher_counters (store_number, trans_kind, last_number)
           VALUES ($1, $2, 1)
         ON CONFLICT (store_number, trans_kind)
           DO UPDATE SET last_number = voucher_counters.last_number + 1
         RETURNING last_number`,
        [store, transKind],
      );
      const seq = String(rows[0]?.last_number ?? '1').padStart(6, '0');
      const candidate = `${prefix}-${store}${seq}`;
      const taken = await em
        .getRepository(VoucherHeader)
        .exist({ where: { voucherNumber: candidate } });
      if (!taken) return candidate;
    }
    throw new ConflictException(
      `Could not allocate a free voucher number for ${transKind}/${store}`,
    );
  }

  /** Current posted stock balance (pieces) for an item in a store. */
  private async stockBalance(
    em: EntityManager,
    itemNumber: string,
    store: string,
  ): Promise<number> {
    const rows: Array<{ qty: string }> = await em.query(
      `SELECT COALESCE(qty, 0) AS qty FROM item_balance WHERE item_number = $1 AND stock_number = $2`,
      [itemNumber, store],
    );
    return rows.length ? Number(rows[0].qty) : 0;
  }

  private resolveStockMovement(
    line: VoucherLineDto,
    qty: number,
    sign: number,
    isTransferVoucher: boolean,
  ): {
    fromStoreNumber: string | null;
    toStoreNumber: string | null;
    storeNumber: string | null;
    signedQty: number;
  } {
    const isTransfer =
      isTransferVoucher || (!!line.fromStoreNumber && !!line.toStoreNumber);
    if (isTransfer) {
      const from = line.fromStoreNumber ?? null;
      const to = line.toStoreNumber ?? null;
      if (!from || !to) {
        throw new BadRequestException(
          'A TRANSFER line requires both fromStoreNumber and toStoreNumber',
        );
      }
      if (from === to) {
        throw new BadRequestException(
          'TRANSFER fromStoreNumber and toStoreNumber must be different stocks',
        );
      }
      return { fromStoreNumber: from, toStoreNumber: to, storeNumber: from, signedQty: 0 };
    }

    const store = line.storeNumber ?? null;
    if (sign < 0) {
      return { fromStoreNumber: store, toStoreNumber: null, storeNumber: store, signedQty: -qty };
    }
    if (sign > 0) {
      return { fromStoreNumber: null, toStoreNumber: store, storeNumber: store, signedQty: qty };
    }
    return { fromStoreNumber: null, toStoreNumber: null, storeNumber: store, signedQty: 0 };
  }

  /** Validate line qty/price inputs before the canonical money engine runs. */
  private validateLines(lines: VoucherLineDto[]): void {
    for (const line of lines) {
      const qty = Number(line.itemQty);
      const unit = Number(line.unitPrice);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('itemQty must be > 0');
      }
      if (!Number.isFinite(unit) || unit < 0) {
        throw new BadRequestException('unitPrice must be >= 0');
      }
    }
  }

  private async loadTransKind(
    em: EntityManager,
    transKind: string,
  ): Promise<TransactionKind> {
    const tk = await em.getRepository(TransactionKind).findOne({
      where: { transKind },
    });
    if (!tk) {
      throw new BadRequestException(`Unknown trans_kind: ${transKind}`);
    }
    return tk;
  }

  // ---- F10: salesman permission gate ------------------------------------

  /**
   * Throws 403 `APPROVAL_REQUIRED:<TYPE>` when the calling salesman lacks the
   * permission for a gated action. Admin/manager roles (and internal calls
   * with no request context, e.g. jobs or approval execution) pass through.
   * Permissions are read fresh from the DB so edits apply without re-login.
   */
  private async enforceSalesmanPolicy(dto: CreateVoucherDto): Promise<void> {
    const ctx = this.userCtx.get();
    if (!ctx) return; // internal call (job / approval execution) — trusted
    if (ctx.role === 'admin' || ctx.role === 'manager') return;

    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: ctx.userId },
    });
    if (!user || user.userType === 'ADMIN') return;
    const keys: string[] = user.permissions ?? [];
    const has = (k: string): boolean => keys.includes(k);

    const num = (v: string | number | undefined | null): number => {
      const n = typeof v === 'number' ? v : Number.parseFloat(v ?? '0');
      return Number.isFinite(n) ? n : 0;
    };

    // 1) RETURN vouchers — two-flag gate:
    //    - no `vouchers.return.create` → not allowed to create returns at all.
    //    - has create + `vouchers.return.approval` → must be approved first
    //      (client files an approval request; the manager's approve() re-runs this
    //      create under their own context, bypassing the gate).
    //    - has create, no approval flag → post directly.
    if (dto.transKind === 'RETURN') {
      // Approval-needed takes precedence and itself authorizes the return (it just
      // routes through a manager). Otherwise a direct return needs the create flag.
      if (has(PERM_RETURN_APPROVAL)) {
        throw new ForbiddenException('APPROVAL_REQUIRED:RETURN_VOUCHER');
      }
      if (!has(PERM_RETURN_CREATE)) {
        throw new ForbiddenException('RETURN_NOT_ALLOWED');
      }
    }

    // 2) Discounts (header + per-line), with an optional max-% cap
    const gross = dto.transactions.reduce(
      (s, l) => s + num(l.itemQty) * num(l.unitPrice),
      0,
    );
    const lineDisc = dto.transactions.reduce(
      (s, l) =>
        s +
        num(l.discountValue) +
        (num(l.discountPercentage) / 100) * num(l.itemQty) * num(l.unitPrice),
      0,
    );
    const headerDisc =
      num(dto.totalDiscountValue) +
      (num(dto.totalDiscountPercentage) / 100) * gross;
    const totalDisc = lineDisc + headerDisc;
    if (totalDisc > 0.0005) {
      if (!has(PERM_DISCOUNT_DIRECT)) {
        // No direct-discount: route to approval if allowed, else block outright.
        if (has(PERM_DISCOUNT_APPROVAL)) {
          throw new ForbiddenException('APPROVAL_REQUIRED:VOUCHER_DISCOUNT');
        }
        throw new ForbiddenException('DISCOUNT_NOT_ALLOWED');
      }
      const maxKey = keys.find((k) => k.startsWith(PERM_DISCOUNT_MAX_PREFIX));
      if (maxKey) {
        const maxPct = num(maxKey.slice(PERM_DISCOUNT_MAX_PREFIX.length));
        const effPct = gross > 0 ? (totalDisc / gross) * 100 : 0;
        if (effPct > maxPct + 1e-9) {
          throw new ForbiddenException('APPROVAL_REQUIRED:VOUCHER_DISCOUNT');
        }
      }
    }

    // 3) Price overrides on SALE lines: flag only when the line UNDERCUTS
    // every legitimate price for the item (catalog, item-units, active price
    // rules, the customer's assigned price list, and per-customer contract
    // prices). Selling above catalog is allowed — it doesn't hurt the owner.
    if (dto.transKind === 'SALE' && !has(PERM_PRICE_OVERRIDE)) {
      for (const line of dto.transactions) {
        const lp = num(line.unitPrice);
        if (lp <= 0) continue;
        const rows: Array<{ p: number | string | null }> = await this.dataSource.query(
          `SELECT ic.price::float8 / 1000 AS p
             FROM item_cart ic WHERE ic.item_number = $1
           UNION ALL
           SELECT iu.sale_price::float8
             FROM item_units iu
             JOIN item_cart ic2 ON ic2.id = iu.item_id
            WHERE ic2.item_number = $1
           UNION ALL
           SELECT CASE
                    WHEN pr.fixed_price IS NOT NULL THEN pr.fixed_price::float8 / 1000
                    ELSE ic3.price::float8 / 1000 * (1 - pr.discount_pct / 100.0)
                  END
             FROM price_rules pr
             JOIN item_cart ic3 ON ic3.id = pr.product_id
            WHERE ic3.item_number = $1
              AND (pr.valid_from IS NULL OR pr.valid_from <= CURRENT_DATE)
              AND (pr.valid_to   IS NULL OR pr.valid_to   >= CURRENT_DATE)
           UNION ALL
           -- The customer's assigned price list (its contracted item price is a
           -- legitimate floor — not a manual override).
           SELECT pli.unit_price::float8 / 1000
             FROM customers c
             JOIN price_list_items pli ON pli.price_list_id = c.price_list_id
             JOIN item_cart ic4 ON ic4.id = pli.item_id
            WHERE c.customer_number = $2 AND ic4.item_number = $1
           UNION ALL
           -- Per-customer contract price (customer_prices mirror + local overrides).
           SELECT cp.unit_price::float8 / 1000
             FROM customers c2
             JOIN customer_prices cp ON cp.customer_id = c2.id
             JOIN item_cart ic5 ON ic5.id = cp.item_id
            WHERE c2.customer_number = $2 AND ic5.item_number = $1
              AND cp.deleted_at IS NULL`,
          [line.itemNumber, dto.customerNumber ?? null],
        );
        const candidates = rows
          .map((r) => Number(r.p))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (candidates.length === 0) continue; // unknown item → other checks decide
        const floor = Math.min(...candidates);
        if (lp < floor - 0.0005) {
          throw new ForbiddenException('APPROVAL_REQUIRED:PRICE_OVERRIDE');
        }
      }
    }
  }
}
