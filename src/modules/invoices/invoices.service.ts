import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import * as ExcelJS from 'exceljs';

import { Invoice } from './entities/invoice.entity';
import { InvoiceLine } from './entities/invoice-line.entity';
import { InvoiceApproval } from './entities/invoice-approval.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { InvoiceNumberService } from './invoice-number.service';
import { calculateInvoice, CalcLineInput } from './invoice-calculator';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { ListInvoicesQuery } from './dto/list-invoices.query';
import { RejectInvoiceDto, OverrideInvoiceDto } from './dto/approval-action.dto';
import { UserContextService } from '../../common/context/user-context.service';
import { filsToJod } from '../../common/utils/currency.util';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
    @InjectRepository(InvoiceLine) private readonly lines: Repository<InvoiceLine>,
    @InjectRepository(InvoiceApproval) private readonly approvals: Repository<InvoiceApproval>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(ItemCart) private readonly products: Repository<ItemCart>,
    private readonly numbers: InvoiceNumberService,
    private readonly bus: EventEmitter2,
    private readonly userCtx: UserContextService,
  ) {}

  async list(q: ListInvoicesQuery): Promise<{ items: Invoice[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (q.repId) where.repId = q.repId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = q.status;
    if (q.from && q.to) where.createdAt = Between(new Date(q.from), new Date(q.to));
    else if (q.from) where.createdAt = MoreThanOrEqual(new Date(q.from));
    else if (q.to) where.createdAt = LessThanOrEqual(new Date(q.to));

    const [items, total] = await this.invoices.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: q.limit ?? 25,
      skip: q.offset ?? 0,
    });
    return { items, total };
  }

  async findOne(id: string): Promise<Invoice> {
    const inv = await this.invoices.findOne({
      where: { id },
      relations: { lines: true },
    });
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);
    return inv;
  }

  async create(dto: CreateInvoiceDto): Promise<Invoice> {
    await this.assertRefExists(this.reps, dto.repId, 'Rep');
    await this.assertRefExists(this.customers, dto.customerId, 'Customer');

    const built = await this.buildLinesAndTotals(dto);
    const invoiceNumber = await this.numbers.next();

    const invoice = this.invoices.create({
      repId: dto.repId,
      customerId: dto.customerId,
      invoiceNumber,
      status: 'draft',
      paymentMethodCode: dto.paymentMethodCode ?? '012',
      note: dto.note ?? null,
      deviceId: dto.deviceId ?? null,
      ...built.totals,
      lines: built.lines,
    });
    const saved = await this.invoices.save(invoice);
    this.bus.emit('invoice.created', { invoiceId: saved.id, repId: saved.repId });
    return this.findOne(saved.id);
  }

  async update(id: string, dto: UpdateInvoiceDto): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status !== 'draft') {
      throw new ConflictException('Only draft invoices can be edited');
    }
    if (dto.lines && dto.lines.length > 0) {
      const built = await this.buildLinesAndTotals({
        customerId: invoice.customerId,
        repId: invoice.repId,
        lines: dto.lines,
        invoiceDiscountType: dto.invoiceDiscountType,
        invoiceDiscountValue: dto.invoiceDiscountValue,
      });
      await this.lines.delete({ invoiceId: id });
      Object.assign(invoice, built.totals);
      invoice.lines = built.lines.map((l) => this.lines.create({ ...l, invoiceId: id }));
    }
    if (dto.paymentMethodCode) invoice.paymentMethodCode = dto.paymentMethodCode;
    if (dto.note !== undefined) invoice.note = dto.note;
    await this.invoices.save(invoice);
    return this.findOne(id);
  }

  async confirm(id: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status !== 'draft') {
      throw new ConflictException(`Cannot confirm an invoice in status '${invoice.status}'`);
    }
    invoice.status = 'confirmed';
    invoice.confirmedAt = new Date();
    invoice.jofotaraUuid = randomUUID();
    await this.invoices.save(invoice);
    await this.writeApproval(id, 'submitted', null);

    // Plan 08 (anomaly) and plan 11 (JoFotara) subscribe to this.
    this.bus.emit('invoice.confirmed', {
      invoiceId: invoice.id,
      repId: invoice.repId,
      customerId: invoice.customerId,
      grandTotal: invoice.grandTotal,
    });
    return this.findOne(id);
  }

  async cancel(id: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status === 'cancelled') return invoice;
    invoice.status = 'cancelled';
    invoice.cancelledAt = new Date();
    await this.invoices.save(invoice);
    return this.findOne(id);
  }

  async approve(id: string, reason?: string): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (!['confirmed', 'pending_approval'].includes(invoice.status)) {
      throw new ConflictException(`Cannot approve an invoice in status '${invoice.status}'`);
    }
    invoice.status = 'confirmed';
    await this.invoices.save(invoice);
    await this.writeApproval(id, 'approved', reason ?? null);
    this.bus.emit('invoice.approved', { invoiceId: id });
    return this.findOne(id);
  }

  async reject(id: string, dto: RejectInvoiceDto): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status === 'cancelled') {
      throw new ConflictException('Cannot reject a cancelled invoice');
    }
    invoice.status = 'draft'; // sent back to the rep to fix
    await this.invoices.save(invoice);
    await this.writeApproval(id, 'rejected', dto.reason);
    this.bus.emit('invoice.rejected', { invoiceId: id, reason: dto.reason });
    return this.findOne(id);
  }

  async override(id: string, dto: OverrideInvoiceDto): Promise<Invoice> {
    const invoice = await this.findOne(id);
    if (invoice.status === 'cancelled') {
      throw new ConflictException('Cannot override a cancelled invoice');
    }
    // Recompute with the overridden invoice-level discount (fixed fils).
    const lineInputs: CalcLineInput[] = (invoice.lines ?? []).map((l) => ({
      quantity: Number(l.quantity),
      unitPrice: l.unitPrice,
      taxType: l.taxType,
      taxRate: Number(l.taxRate),
      lineDiscountType: l.lineDiscountType,
      lineDiscountValue: Number(l.lineDiscountValue),
    }));
    const calc = calculateInvoice({
      lines: lineInputs,
      invoiceDiscountType: 'FIXED_AMOUNT',
      invoiceDiscountValue: dto.invoiceDiscountAmount,
    });
    this.applyCalcToInvoice(invoice, calc);
    // rewrite line breakdowns
    if (invoice.lines) {
      invoice.lines.forEach((l, i) => {
        const c = calc.lines[i];
        l.lineDiscountAmount = c.lineDiscountAmount;
        l.netAfterLineDiscount = c.netAfterLineDiscount;
        l.taxableBase = c.taxableBase;
        l.taxAmount = c.taxAmount;
        l.lineTotal = c.lineTotal;
      });
    }
    await this.invoices.save(invoice);
    await this.writeApproval(id, 'override', dto.reason ?? null);
    return this.findOne(id);
  }

  async audit(id: string): Promise<InvoiceApproval[]> {
    await this.findOne(id);
    return this.approvals.find({
      where: { invoiceId: id },
      order: { actedAt: 'ASC' },
    });
  }

  async exportXlsx(from?: string, to?: string): Promise<Buffer> {
    const where: Record<string, unknown> = {};
    if (from && to) where.createdAt = Between(new Date(from), new Date(to));
    else if (from) where.createdAt = MoreThanOrEqual(new Date(from));
    else if (to) where.createdAt = LessThanOrEqual(new Date(to));

    const invoices = await this.invoices.find({
      where,
      relations: { lines: true },
      order: { createdAt: 'DESC' },
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoices');
    ws.columns = [
      { header: 'Invoice #', key: 'num', width: 22 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Date', key: 'date', width: 22 },
      { header: 'Product', key: 'product', width: 18 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Unit (JOD)', key: 'unit', width: 12 },
      { header: 'Line Total (JOD)', key: 'lineTotal', width: 16 },
      { header: 'Tax (JOD)', key: 'tax', width: 12 },
      { header: 'Grand Total (JOD)', key: 'grand', width: 18 },
    ];
    for (const inv of invoices) {
      const lines = inv.lines ?? [];
      if (lines.length === 0) {
        ws.addRow({
          num: inv.invoiceNumber,
          status: inv.status,
          date: inv.createdAt.toISOString(),
          grand: filsToJod(inv.grandTotal),
        });
        continue;
      }
      lines.forEach((l, idx) => {
        ws.addRow({
          num: inv.invoiceNumber,
          status: inv.status,
          date: inv.createdAt.toISOString(),
          product: l.productId,
          qty: Number(l.quantity),
          unit: filsToJod(l.unitPrice),
          lineTotal: filsToJod(l.lineTotal),
          tax: filsToJod(l.taxAmount),
          grand: idx === 0 ? filsToJod(inv.grandTotal) : '',
        });
      });
    }
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }

  // ---- helpers ----

  private async buildLinesAndTotals(dto: {
    customerId: string;
    repId: string;
    lines: CreateInvoiceDto['lines'];
    invoiceDiscountType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
    invoiceDiscountValue?: number;
  }): Promise<{ lines: InvoiceLine[]; totals: Partial<Invoice> }> {
    const productIds = dto.lines.map((l) => l.productId);
    const products = await this.products.find({ where: { id: In(productIds) } });
    const byId = new Map(products.map((p) => [p.id, p]));
    if (byId.size !== new Set(productIds).size) {
      throw new BadRequestException('One or more products do not exist');
    }

    const calcInputs: CalcLineInput[] = dto.lines.map((l) => {
      const p = byId.get(l.productId)!;
      return {
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? p.price,
        taxType: p.taxType,
        taxRate: Number(p.taxRate),
        lineDiscountType: l.lineDiscountType ?? 'PERCENTAGE',
        lineDiscountValue: l.lineDiscountValue ?? 0,
      };
    });

    const calc = calculateInvoice({
      lines: calcInputs,
      invoiceDiscountType: dto.invoiceDiscountType,
      invoiceDiscountValue: dto.invoiceDiscountValue,
    });

    const lines = dto.lines.map((l, i) => {
      const p = byId.get(l.productId)!;
      const c = calc.lines[i];
      return this.lines.create({
        productId: l.productId,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice ?? p.price,
        unitOfMeasure: p.unitOfMeasure,
        taxType: p.taxType,
        taxCategory: p.taxCategory,
        taxRate: Number(p.taxRate).toFixed(4),
        subtotal: c.subtotal,
        lineDiscountType: l.lineDiscountType ?? 'PERCENTAGE',
        lineDiscountValue: (l.lineDiscountValue ?? 0).toString(),
        lineDiscountAmount: c.lineDiscountAmount,
        netAfterLineDiscount: c.netAfterLineDiscount,
        taxableBase: c.taxableBase,
        taxAmount: c.taxAmount,
        lineTotal: c.lineTotal,
      });
    });

    const totals: Partial<Invoice> = {
      subtotal: calc.subtotal,
      totalLineDiscounts: calc.totalLineDiscounts,
      invoiceDiscountAmount: calc.invoiceDiscountAmount,
      netTaxable: calc.netTaxable,
      netInclusive: calc.netInclusive,
      netExempt: calc.netExempt,
      taxOnTaxable: calc.taxOnTaxable,
      taxExtractedFromInclusive: calc.taxExtractedFromInclusive,
      totalTax: calc.totalTax,
      grandTotal: calc.grandTotal,
    };
    return { lines, totals };
  }

  private applyCalcToInvoice(
    invoice: Invoice,
    calc: ReturnType<typeof calculateInvoice>,
  ): void {
    invoice.subtotal = calc.subtotal;
    invoice.totalLineDiscounts = calc.totalLineDiscounts;
    invoice.invoiceDiscountAmount = calc.invoiceDiscountAmount;
    invoice.netTaxable = calc.netTaxable;
    invoice.netInclusive = calc.netInclusive;
    invoice.netExempt = calc.netExempt;
    invoice.taxOnTaxable = calc.taxOnTaxable;
    invoice.taxExtractedFromInclusive = calc.taxExtractedFromInclusive;
    invoice.totalTax = calc.totalTax;
    invoice.grandTotal = calc.grandTotal;
  }

  private async writeApproval(
    invoiceId: string,
    action: InvoiceApproval['action'],
    reason: string | null,
  ): Promise<void> {
    await this.approvals.save(
      this.approvals.create({
        invoiceId,
        action,
        actorId: this.userCtx.getUserId(),
        reason,
      }),
    );
  }

  private async assertRefExists(
    repo: Repository<{ id: string }>,
    id: string,
    label: string,
  ): Promise<void> {
    if (!(await repo.exist({ where: { id } }))) {
      throw new BadRequestException(`${label} ${id} not found`);
    }
  }
}
