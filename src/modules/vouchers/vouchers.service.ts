import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
import { User } from '../users/entities/user.entity';
import { Rep } from '../reps/entities/rep.entity';

import {
  CreateVoucherDto,
  VoucherLineDto,
} from './dto/create-voucher.dto';
import { ListVouchersQueryDto } from './dto/list-vouchers-query.dto';
import { UserContextService } from '../../common/context/user-context.service';
import { OffersService } from '../offers/offers.service';
import { OffersEngineService } from '../offers/offers-engine.service';
import type { EvaluationResult } from '../offers/offers.types';

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

interface ComputedLine {
  line: VoucherLineDto;
  net: number;
  tax: number;
  total: number;
}

/** Permission keys gating sensitive salesman actions (F10). */
export const PERM_RETURN_DIRECT = 'vouchers.return.direct';
export const PERM_DISCOUNT_DIRECT = 'vouchers.discount.direct';
export const PERM_PRICE_OVERRIDE = 'vouchers.priceOverride';
/** Prefix key encoding the max direct-discount %, e.g. "vouchers.discount.max:5". */
export const PERM_DISCOUNT_MAX_PREFIX = 'vouchers.discount.max:';

@Injectable()
export class VouchersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(VoucherHeader)
    private readonly headersRepo: Repository<VoucherHeader>,
    @InjectRepository(PaymentCheque)
    private readonly chequesRepo: Repository<PaymentCheque>,
    private readonly userCtx: UserContextService,
    private readonly events: EventEmitter2,
    private readonly offers: OffersService,
    private readonly offersEngine: OffersEngineService,
  ) {}

  private readonly logger = new Logger(VouchersService.name);

  async create(dto: CreateVoucherDto): Promise<VoucherHeader> {
    // F10 gate: salesmen need explicit permission for returns, discounts and
    // price overrides — otherwise the client must file an approval request
    // (the approving manager re-runs create() under their own role). Runs BEFORE
    // offers so system-granted offer discounts bypass the manual-discount gate.
    await this.enforceSalesmanPolicy(dto);
    const result = await this.createUnchecked(dto);
    // Mirror posted vouchers to the ERP (ErpSync listener filters by kind + enqueues
    // an outbox push; no-op when ERP off). Stock IN/OUT adjustments aren't mirrored.
    if (result.isPosted) {
      this.events.emit('erp.voucher.posted', {
        voucherNumber: result.voucherNumber,
        transKind: result.transKind,
      });
    }
    return result;
    const offerResult = await this.applyOffers(dto);
    const header = await this.createUnchecked(dto);
    await this.recordOfferRedemptions(header, offerResult);
    return header;
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
      if (result.freeLines.length) {
        const names = await this.loadItemNames(
          result.freeLines.map((f) => f.itemNumber),
        );
        const saleStore = dto.transactions.find((t) => t.storeNumber)
          ?.storeNumber;
        for (const f of result.freeLines) {
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
    return new Map(items.map((i) => [i.itemNumber, i.name ?? i.itemNumber]));
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
      if (itemNumbers.length) {
        const items = await em.getRepository(ItemCart).find({
          where: { itemNumber: In(itemNumbers) },
        });
        const taxByItem = new Map(items.map((i) => [i.itemNumber, i.taxPercentage]));
        for (const line of dto.transactions) {
          const tax = taxByItem.get(line.itemNumber);
          if (tax !== undefined && tax !== null) line.taxPercentage = String(tax);
        }
      }

      const computed = dto.transactions.map((line) => this.computeLine(line));
      const totalNet = computed.reduce((s, c) => s + c.net, 0);
      const totalTax = computed.reduce((s, c) => s + c.tax, 0);
      const totalGross = computed.reduce((s, c) => s + c.total, 0);
      const headerDiscount = Number(dto.totalDiscountValue ?? 0);
      const netTotal = totalGross - headerDiscount;

      const header = em.getRepository(VoucherHeader).create({
        voucherNumber: dto.voucherNumber,
        transKind: dto.transKind,
        userCode: dto.userCode,
        customerNumber: dto.customerNumber ?? null,
        vendorNumber: dto.vendorNumber ?? null,
        referenceVoucherNumber,
        inDate: dto.inDate ? new Date(dto.inDate) : new Date(),
        total: totalNet.toFixed(2),
        totalTax: totalTax.toFixed(2),
        netTotal: netTotal.toFixed(2),
        totalDiscountValue: (dto.totalDiscountValue ?? '0').toString(),
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
      for (const { line, net, total } of computed) {
        const lineKind = line.transKind ?? dto.transKind;
        const unitFactor =
          line.unitBaseQty && line.unitBaseQty > 0 ? line.unitBaseQty : 1;
        const qtyOfUnit = Number(line.itemQty);
        const baseQty = qtyOfUnit * unitFactor;
        const sign = await resolveSign(lineKind);
        const move = this.resolveStockMovement(line, baseQty, sign, isTransferVoucher);
        prepared.push({ line, net, total, lineKind, unitFactor, qtyOfUnit, baseQty, move });
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

      const txEntities = prepared.map((p) =>
        em.getRepository(VoucherTransaction).create({
          voucherNumber: dto.voucherNumber,
          itemNumber: p.line.itemNumber,
          itemName: p.line.itemName,
          transKind: p.lineKind,
          storeNumber: p.move.storeNumber,
          fromStoreNumber: p.move.fromStoreNumber,
          toStoreNumber: p.move.toStoreNumber,
          taxPercentage: p.line.taxPercentage ?? '0',
          discountPercentage: p.line.discountPercentage ?? '0',
          discountValue: p.line.discountValue ?? '0',
          itemQty: p.baseQty.toString(),
          unitPrice: (p.line.unitPrice ?? '0').toString(),
          qtyOfUnit: p.qtyOfUnit.toString(),
          unitCode: p.line.unitCode ?? null,
          unitName: p.line.unitName ?? null,
          unitBaseQty: p.unitFactor,
          signedQty: p.move.signedQty.toString(),
          total: p.net.toFixed(2),
          netTotal: p.total.toFixed(2),
        }),
      );
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
    return this.dataSource.transaction(async (em) => {
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

  private computeLine(line: VoucherLineDto): ComputedLine {
    const qty = Number(line.itemQty);
    const unit = Number(line.unitPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new BadRequestException('itemQty must be > 0');
    }
    if (!Number.isFinite(unit) || unit < 0) {
      throw new BadRequestException('unitPrice must be >= 0');
    }
    const lineGross = qty * unit;
    const discPct = Number(line.discountPercentage ?? 0);
    const discVal = Number(line.discountValue ?? 0);
    const afterDiscount =
      lineGross - lineGross * (discPct / 100) - discVal;
    const taxPct = Number(line.taxPercentage ?? 0);
    const tax = afterDiscount * (taxPct / 100);
    return {
      line,
      net: afterDiscount,
      tax,
      total: afterDiscount + tax,
    };
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

    // 1) RETURN vouchers — post directly like SALE/ORDER (no approval gate).

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
        throw new ForbiddenException('APPROVAL_REQUIRED:VOUCHER_DISCOUNT');
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
    // rules). Selling above catalog is allowed — it doesn't hurt the owner.
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
              AND (pr.valid_to   IS NULL OR pr.valid_to   >= CURRENT_DATE)`,
          [line.itemNumber],
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
