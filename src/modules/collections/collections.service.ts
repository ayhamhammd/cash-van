import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Between,
  type EntityManager,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { Collection } from './entities/collection.entity';
import { Cheque } from './entities/cheque.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { ListCollectionsQuery } from './dto/query.dto';
import { BatchDepositDto } from './dto/collection-actions.dto';

export interface CollectionsSummary {
  date: string;
  totalCollectedFils: number;
  cashFils: number;
  chequeFils: number;
  pendingFils: number;
  overdueChequeFils: number;
}

export interface AgingBuckets {
  asOf: string;
  buckets: { label: string; count: number; amountFils: number }[];
  totalOutstandingFils: number;
}

@Injectable()
export class CollectionsService {
  constructor(
    @InjectRepository(Collection) private readonly collections: Repository<Collection>,
    @InjectRepository(Cheque) private readonly cheques: Repository<Cheque>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    private readonly events: EventEmitter2,
  ) {}

  async list(q: ListCollectionsQuery): Promise<{ items: Collection[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (q.repId) where.repId = q.repId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.method) where.method = q.method;
    if (q.status) where.status = q.status;
    if (q.from && q.to) where.collectedAt = Between(new Date(q.from), new Date(q.to));
    else if (q.from) where.collectedAt = MoreThanOrEqual(new Date(q.from));
    else if (q.to) where.collectedAt = LessThanOrEqual(new Date(q.to));

    const [items, total] = await this.collections.findAndCount({
      where,
      relations: { cheque: true },
      order: { collectedAt: 'DESC' },
      take: q.limit ?? 25,
      skip: q.offset ?? 0,
    });
    return { items, total };
  }

  async findOne(id: string): Promise<Collection> {
    const c = await this.collections.findOne({
      where: { id },
      relations: { cheque: true },
    });
    if (!c) throw new NotFoundException(`Collection ${id} not found`);
    return c;
  }

  /**
   * Atomic per-warehouse payment (C) counter → "C-<store>-<6 digits>".
   * Reuses voucher_counters with trans_kind='PAYMENT'; the next number always
   * continues from the last saved one (counter increments).
   */
  private async nextCollectionNumber(em: EntityManager, store: string): Promise<string> {
    const rows: Array<{ last_number: string }> = await em.query(
      `INSERT INTO voucher_counters (store_number, trans_kind, last_number)
       VALUES ($1, 'PAYMENT', 1)
       ON CONFLICT (store_number, trans_kind)
       DO UPDATE SET last_number = voucher_counters.last_number + 1
       RETURNING last_number`,
      [store],
    );
    const seq = Number(rows[0]?.last_number ?? 1);
    return `C-${store}-${String(seq).padStart(6, '0')}`;
  }

  async create(dto: CreateCollectionDto): Promise<Collection> {
    const rep = await this.reps.findOne({ where: { id: dto.repId } });
    if (!rep) {
      throw new BadRequestException(`Rep ${dto.repId} not found`);
    }
    if (!(await this.customers.exist({ where: { id: dto.customerId } }))) {
      throw new BadRequestException(`Customer ${dto.customerId} not found`);
    }
    if (dto.method === 'cheque' && !dto.cheque) {
      throw new BadRequestException('cheque details are required when method=cheque');
    }

    // Collections are confirmed on creation (both cash-van app and dashboard),
    // so a recorded payment immediately counts and queues to the ERP. The only
    // exception is a cheque whose amount-in-words doesn't match — that must be
    // reconciled first, so it stays 'pending' for the reconcile queue.
    const isMismatchCheque =
      dto.method === 'cheque' && dto.cheque?.wordsMatch === false;
    const initialStatus = isMismatchCheque ? 'pending' : 'confirmed';

    const created = await this.collections.manager.transaction(async (em) => {
      // Per-warehouse payment (C) number, keyed off the rep's van store.
      const collectionNumber = await this.nextCollectionNumber(em, rep.code ?? dto.repId);
      const collection = await em.getRepository(Collection).save(
        em.getRepository(Collection).create({
          repId: dto.repId,
          customerId: dto.customerId,
          collectionNumber,
          invoiceId: dto.invoiceId ?? null,
          amount: dto.amount,
          method: dto.method,
          status: initialStatus,
          confirmedAt: initialStatus === 'confirmed' ? new Date() : null,
          collectedAt: dto.collectedAt ? new Date(dto.collectedAt) : new Date(),
          note: dto.note ?? null,
        }),
      );

      if (dto.method === 'cheque' && dto.cheque) {
        const c = dto.cheque;
        await em.getRepository(Cheque).save(
          em.getRepository(Cheque).create({
            collectionId: collection.id,
            bankName: c.bankName ?? null,
            chequeNumber: c.chequeNumber ?? null,
            payee: c.payee ?? null,
            amount: dto.amount,
            amountWords: c.amountWords ?? null,
            dueDate: c.dueDate ?? null,
            ocrConfidence: c.ocrConfidence ?? null,
            wordsMatch: c.wordsMatch ?? true,
            scanSource: c.scanSource ?? 'server',
            imagePath: c.imagePath ?? null,
            scannedAt: c.imagePath ? new Date() : null,
            status: 'pending',
          }),
        );
      }
      return em.getRepository(Collection).findOneOrFail({
        where: { id: collection.id },
        relations: { cheque: true },
      });
    });

    // Mirror the confirmed receipt to the ERP (best-effort; no-op when ERP off).
    if (created.status === 'confirmed') {
      this.events.emit('erp.collection.confirmed', { collectionId: created.id });
    }
    return created;
  }

  async confirm(id: string): Promise<Collection> {
    const collection = await this.findOne(id);
    if (collection.status !== 'pending') {
      throw new ConflictException(`Cannot confirm a collection in status '${collection.status}'`);
    }
    // Block confirm on an unreconciled words-mismatch cheque.
    if (collection.method === 'cheque' && collection.cheque) {
      const ch = collection.cheque;
      if (!ch.wordsMatch && !ch.reconciledAt) {
        throw new ConflictException(
          'Cheque amount-in-words mismatch must be reconciled before confirming',
        );
      }
    }
    collection.status = 'confirmed';
    collection.confirmedAt = new Date();
    await this.collections.save(collection);
    // Mirror the confirmed receipt to the ERP (best-effort; no-op when ERP off).
    this.events.emit('erp.collection.confirmed', { collectionId: id });
    return this.findOne(id);
  }

  /**
   * Edit a collection — allowed only while it is still `pending` (not yet
   * confirmed/pushed to the ERP, whose receipts are immutable). Updates the
   * collection fields and, for cheques, the linked cheque record.
   */
  async update(id: string, dto: UpdateCollectionDto): Promise<Collection> {
    const collection = await this.findOne(id);
    if (collection.status !== 'pending') {
      throw new ConflictException(
        `Only a pending collection can be edited (status '${collection.status}')`,
      );
    }
    if (dto.customerId && !(await this.customers.exist({ where: { id: dto.customerId } }))) {
      throw new BadRequestException(`Customer ${dto.customerId} not found`);
    }
    const method = dto.method ?? collection.method;
    if (method === 'cheque' && !collection.cheque && !dto.cheque) {
      throw new BadRequestException('cheque details are required when method=cheque');
    }

    return this.collections.manager.transaction(async (em) => {
      if (dto.customerId !== undefined) collection.customerId = dto.customerId;
      if (dto.invoiceId !== undefined) collection.invoiceId = dto.invoiceId ?? null;
      if (dto.amount !== undefined) collection.amount = dto.amount;
      if (dto.method !== undefined) collection.method = dto.method;
      if (dto.collectedAt !== undefined) collection.collectedAt = new Date(dto.collectedAt);
      if (dto.note !== undefined) collection.note = dto.note ?? null;
      await em.getRepository(Collection).save(collection);

      if (dto.cheque) {
        const repo = em.getRepository(Cheque);
        const existing = await repo.findOne({ where: { collectionId: id } });
        const c = dto.cheque;
        const row = existing ?? repo.create({ collectionId: id, status: 'pending' });
        if (c.bankName !== undefined) row.bankName = c.bankName ?? null;
        if (c.chequeNumber !== undefined) row.chequeNumber = c.chequeNumber ?? null;
        if (c.payee !== undefined) row.payee = c.payee ?? null;
        if (c.amountWords !== undefined) row.amountWords = c.amountWords ?? null;
        if (c.dueDate !== undefined) row.dueDate = c.dueDate ?? null;
        if (c.wordsMatch !== undefined) row.wordsMatch = c.wordsMatch;
        row.amount = dto.amount ?? collection.amount;
        await repo.save(row);
      }

      return em.getRepository(Collection).findOneOrFail({
        where: { id },
        relations: { cheque: true },
      });
    });
  }

  async batchDeposit(dto: BatchDepositDto): Promise<{ deposited: number; skipped: string[] }> {
    const rows = await this.collections.find({ where: { id: In(dto.collectionIds) } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const skipped: string[] = [];
    let deposited = 0;
    await this.collections.manager.transaction(async (em) => {
      for (const id of dto.collectionIds) {
        const c = byId.get(id);
        if (!c || c.status !== 'confirmed') {
          skipped.push(id);
          continue;
        }
        c.status = 'deposited';
        c.depositedAt = new Date();
        await em.getRepository(Collection).save(c);
        deposited++;
      }
    });
    return { deposited, skipped };
  }

  async summary(date?: string): Promise<CollectionsSummary> {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${day}T23:59:59.999Z`);

    const dayRows = await this.collections.find({
      where: { collectedAt: Between(start, end) },
    });
    const sumBy = (pred: (c: Collection) => boolean) =>
      dayRows.filter(pred).reduce((a, c) => a + c.amount, 0);

    const totalCollectedFils = sumBy((c) => c.status === 'confirmed' || c.status === 'deposited');
    const cashFils = sumBy((c) => c.method === 'cash' && c.status !== 'pending' && c.status !== 'bounced');
    const chequeFils = sumBy((c) => c.method === 'cheque' && c.status !== 'pending' && c.status !== 'bounced');
    const pendingFils = sumBy((c) => c.status === 'pending');

    // Overdue cheques: uncleared, due_date < today.
    const today = new Date().toISOString().slice(0, 10);
    const overdue = (await this.cheques
      .createQueryBuilder('ch')
      .select('COALESCE(SUM(ch.amount),0)', 'sum')
      .where('ch.status = :st', { st: 'pending' })
      .andWhere('ch.due_date IS NOT NULL AND ch.due_date < :today', { today })
      .getRawOne()) as { sum: string };

    return {
      date: day,
      totalCollectedFils,
      cashFils,
      chequeFils,
      pendingFils,
      overdueChequeFils: Number(overdue.sum),
    };
  }

  /** Aging of uncleared cheques by days past due_date. */
  async aging(): Promise<AgingBuckets> {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const pending = await this.cheques.find({ where: { status: 'pending' } });

    const defs = [
      { label: '0-7', min: 0, max: 7 },
      { label: '8-30', min: 8, max: 30 },
      { label: '31-60', min: 31, max: 60 },
      { label: '60+', min: 61, max: Infinity },
    ];
    const buckets = defs.map((d) => ({ label: d.label, count: 0, amountFils: 0 }));
    let totalOutstandingFils = 0;

    for (const ch of pending) {
      if (!ch.dueDate) continue;
      const due = new Date(`${ch.dueDate}T00:00:00.000Z`);
      const daysOverdue = Math.floor(
        (Date.parse(`${todayStr}T00:00:00.000Z`) - due.getTime()) / 86_400_000,
      );
      if (daysOverdue < 0) continue; // not yet due
      const idx = defs.findIndex((d) => daysOverdue >= d.min && daysOverdue <= d.max);
      if (idx >= 0) {
        buckets[idx].count++;
        buckets[idx].amountFils += ch.amount;
        totalOutstandingFils += ch.amount;
      }
    }
    return { asOf: todayStr, buckets, totalOutstandingFils };
  }
}
