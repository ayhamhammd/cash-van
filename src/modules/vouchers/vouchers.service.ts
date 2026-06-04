import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

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
      const dup = await em.getRepository(VoucherHeader).exist({
        where: { voucherNumber: dto.voucherNumber },
      });
      if (dup) {
        throw new ConflictException(
          `Voucher ${dto.voucherNumber} already exists`,
        );
      }
      const tk = await this.loadTransKind(em, dto.transKind);

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

      const txEntities = computed.map(({ line, net, total }) => {
        const lineKind = line.transKind ?? dto.transKind;
        const qty = Number(line.itemQty);
        const sign = tk.sign;
        return em.getRepository(VoucherTransaction).create({
          voucherNumber: dto.voucherNumber,
          itemNumber: line.itemNumber,
          itemName: line.itemName,
          transKind: lineKind,
          storeNumber: line.storeNumber ?? null,
          taxPercentage: line.taxPercentage ?? '0',
          discountPercentage: line.discountPercentage ?? '0',
          discountValue: line.discountValue ?? '0',
          itemQty: qty.toString(),
          signedQty: (sign * qty).toString(),
          total: net.toFixed(2),
          netTotal: total.toFixed(2),
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

  list(): Promise<VoucherHeader[]> {
    return this.headersRepo.find({
      order: { inDate: 'DESC' },
    });
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
