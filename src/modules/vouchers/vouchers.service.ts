import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
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

@Injectable()
export class VouchersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(VoucherHeader)
    private readonly headersRepo: Repository<VoucherHeader>,
    @InjectRepository(PaymentCheque)
    private readonly chequesRepo: Repository<PaymentCheque>,
  ) {}

  async create(dto: CreateVoucherDto): Promise<VoucherHeader> {
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
  ): Promise<Array<VoucherHeader & { storeNumber: string | null }>> {
    const qb = this.headersRepo
      .createQueryBuilder('h')
      .leftJoin(
        'voucher_transactions',
        'vt',
        'vt.voucher_number = h.voucher_number',
      )
      .addSelect(
        'MIN(COALESCE(vt.store_number, vt.from_store_number, vt.to_store_number))',
        'storeNumber',
      )
      .groupBy('h.id')
      .orderBy('h.in_date', 'DESC');

    if (q.transKind) qb.andWhere('h.trans_kind = :tk', { tk: q.transKind });
    if (q.userCode) qb.andWhere('h.user_code = :uc', { uc: q.userCode });
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
  /** Next global serial voucher number: <prefix>-<storeNumber><6-digit serial>. */
  private async nextVoucherNumber(
    em: EntityManager,
    transKind: string,
    store: string,
  ): Promise<string> {
    const rows: Array<{ n: string }> = await em.query(
      `SELECT nextval('voucher_number_seq') AS n`,
    );
    const seq = String(rows[0]?.n ?? '0').padStart(6, '0');
    const prefix = VOUCHER_PREFIX[transKind] ?? transKind.slice(0, 3).toUpperCase();
    return `${prefix}-${store}${seq}`;
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
}
