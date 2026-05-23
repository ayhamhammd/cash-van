import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { Collection } from './entities/collection.entity';
import { Cheque } from './entities/cheque.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CreateCollectionDto } from './dto/create-collection.dto';
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

  async create(dto: CreateCollectionDto): Promise<Collection> {
    if (!(await this.reps.exist({ where: { id: dto.repId } }))) {
      throw new BadRequestException(`Rep ${dto.repId} not found`);
    }
    if (!(await this.customers.exist({ where: { id: dto.customerId } }))) {
      throw new BadRequestException(`Customer ${dto.customerId} not found`);
    }
    if (dto.method === 'cheque' && !dto.cheque) {
      throw new BadRequestException('cheque details are required when method=cheque');
    }

    return this.collections.manager.transaction(async (em) => {
      const collection = await em.getRepository(Collection).save(
        em.getRepository(Collection).create({
          repId: dto.repId,
          customerId: dto.customerId,
          invoiceId: dto.invoiceId ?? null,
          amount: dto.amount,
          method: dto.method,
          status: 'pending',
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
    return this.findOne(id);
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
