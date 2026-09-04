import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';

import { CustomerSegment } from './entities/customer-segment.entity';
import { SegmentCustomer } from './entities/segment-customer.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { ListSegmentsQuery } from './dto/list-segments.query';
import { ListMembersQuery } from './dto/list-members.query';
import { AddMembersDto } from './dto/add-members.dto';
import { applyTokenSearch } from '../../common/search/token-search.util';

/** A rep_id no customer has — used so an empty supervisor scope matches nothing. */
const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000';

export interface SegmentView {
  id: string;
  nameAr: string;
  nameEn: string | null;
  description: string | null;
  color: string | null;
  kind: string;
  rules: Record<string, unknown> | null;
  isActive: boolean;
  isSystem: boolean;
  memberCount: number;
  createdAt: Date;
}

export interface SegmentMemberView {
  customerId: string;
  customerNumber: string;
  nameAr: string;
  nameEn: string | null;
  repId: string | null;
  source: string;
  addedAt: Date;
}

/** A segment badge for a customer profile. */
export interface CustomerSegmentTag {
  id: string;
  nameAr: string;
  nameEn: string | null;
  color: string | null;
}

@Injectable()
export class SegmentsService {
  constructor(
    @InjectRepository(CustomerSegment)
    private readonly segments: Repository<CustomerSegment>,
    @InjectRepository(SegmentCustomer)
    private readonly members: Repository<SegmentCustomer>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly events: EventEmitter2,
  ) {}

  // ── Segments ────────────────────────────────────────────────────────────

  async list(query: ListSegmentsQuery): Promise<{ items: SegmentView[]; total: number }> {
    const qb = this.segments
      .createQueryBuilder('s')
      .where('s.deleted_at IS NULL')
      .orderBy('s.created_at', 'DESC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    applyTokenSearch(qb, query.q, ['s.name_ar', 's.name_en']);
    if (query.kind) qb.andWhere('s.kind = :k', { k: query.kind });
    if (query.isActive !== undefined) qb.andWhere('s.is_active = :a', { a: query.isActive });

    const [rows, total] = await qb.getManyAndCount();
    const counts = await this.memberCounts(rows.map((r) => r.id));
    return { items: rows.map((r) => this.toView(r, counts.get(r.id) ?? 0)), total };
  }

  async findOneOrThrow(id: string): Promise<CustomerSegment> {
    const s = await this.segments.findOne({ where: { id } });
    if (!s) throw new NotFoundException(`Segment ${id} not found`);
    return s;
  }

  async getOne(id: string): Promise<SegmentView> {
    const s = await this.findOneOrThrow(id);
    return this.toView(s, await this.count(id));
  }

  async create(dto: CreateSegmentDto, userId?: string | null): Promise<SegmentView> {
    const row = this.segments.create({
      nameAr: dto.nameAr,
      nameEn: dto.nameEn ?? null,
      description: dto.description ?? null,
      color: dto.color ?? null,
      kind: dto.kind ?? 'STATIC',
      rules: dto.rules ?? null,
      isActive: dto.isActive ?? true,
      createdBy: userId ?? null,
    });
    const saved = await this.segments.save(row);
    this.events.emit('segment.changed', { segmentId: saved.id, reason: 'created' });
    return this.toView(saved, 0);
  }

  async update(id: string, dto: UpdateSegmentDto): Promise<SegmentView> {
    const s = await this.findOneOrThrow(id);
    if (dto.nameAr !== undefined) s.nameAr = dto.nameAr;
    if (dto.nameEn !== undefined) s.nameEn = dto.nameEn ?? null;
    if (dto.description !== undefined) s.description = dto.description ?? null;
    if (dto.color !== undefined) s.color = dto.color ?? null;
    if (dto.kind !== undefined) s.kind = dto.kind;
    if (dto.rules !== undefined) s.rules = dto.rules ?? null;
    if (dto.isActive !== undefined) s.isActive = dto.isActive;
    const saved = await this.segments.save(s);
    this.events.emit('segment.changed', { segmentId: id, reason: 'updated' });
    return this.toView(saved, await this.count(id));
  }

  async remove(id: string): Promise<void> {
    await this.findOneOrThrow(id);
    // Membership rows go with the segment — they are meaningless without it.
    await this.members.delete({ segmentId: id });
    await this.segments.softDelete(id);
    this.events.emit('segment.changed', { segmentId: id, reason: 'deleted' });
  }

  // ── Membership ──────────────────────────────────────────────────────────

  async listMembers(
    id: string,
    query: ListMembersQuery,
    visibleRepIds: string[] | null = null,
  ): Promise<{ items: SegmentMemberView[]; total: number }> {
    await this.findOneOrThrow(id);
    const qb = this.members
      .createQueryBuilder('m')
      .innerJoin(Customer, 'c', 'c.id = m.customer_id AND c.deleted_at IS NULL')
      .where('m.segment_id = :id', { id });

    applyTokenSearch(qb, query.q, ['c.name_ar', 'c.name_en', 'c.customer_number']);
    // Supervisor scope: a rep-scoped user only sees their own reps' customers.
    if (visibleRepIds !== null) {
      qb.andWhere('c.rep_id IN (:...vis)', {
        vis: visibleRepIds.length ? visibleRepIds : [NO_MATCH_UUID],
      });
    }

    // Count the filtered set before paginating it.
    const total = await qb.clone().getCount();

    const items = await qb
      .select([
        'm.customer_id AS "customerId"',
        'c.customer_number AS "customerNumber"',
        'c.name_ar AS "nameAr"',
        'c.name_en AS "nameEn"',
        'c.rep_id AS "repId"',
        'm.source AS source',
        'm.added_at AS "addedAt"',
      ])
      .orderBy('m.added_at', 'DESC')
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0)
      .getRawMany<SegmentMemberView>();
    return { items, total };
  }

  async addMembers(
    id: string,
    dto: AddMembersDto,
    userId?: string | null,
  ): Promise<{ added: number; total: number }> {
    await this.findOneOrThrow(id);

    const ids = new Set(dto.customerIds ?? []);
    if (dto.customerNumbers?.length) {
      const found = await this.customers.find({
        where: { customerNumber: In(dto.customerNumbers) },
        select: { id: true },
      });
      found.forEach((c) => ids.add(c.id));
    }
    const wanted = [...ids];
    if (!wanted.length) return { added: 0, total: await this.count(id) };

    // Skip customers already in the segment so `added` is an honest count.
    const existing = await this.members.find({
      where: { segmentId: id, customerId: In(wanted) },
      select: { customerId: true },
    });
    const have = new Set(existing.map((e) => e.customerId));
    const toAdd = wanted.filter((c) => !have.has(c));

    if (toAdd.length) {
      // orIgnore covers the race where a concurrent add slips the same pair past
      // the pre-check — the unique index would otherwise throw.
      await this.members
        .createQueryBuilder()
        .insert()
        .into(SegmentCustomer)
        .values(
          toAdd.map((customerId) => ({
            segmentId: id,
            customerId,
            source: 'MANUAL' as const,
            addedBy: userId ?? null,
          })),
        )
        .orIgnore()
        .execute();
      this.events.emit('segment.changed', { segmentId: id, reason: 'members.added' });
    }
    return { added: toAdd.length, total: await this.count(id) };
  }

  async removeMember(id: string, customerId: string): Promise<{ total: number }> {
    await this.findOneOrThrow(id);
    await this.members.delete({ segmentId: id, customerId });
    this.events.emit('segment.changed', { segmentId: id, reason: 'members.removed' });
    return { total: await this.count(id) };
  }

  /** The segments a customer belongs to — for the profile's segment chips. */
  async segmentsForCustomer(customerId: string): Promise<CustomerSegmentTag[]> {
    return this.members
      .createQueryBuilder('m')
      .innerJoin(CustomerSegment, 's', 's.id = m.segment_id AND s.deleted_at IS NULL')
      .where('m.customer_id = :cid', { cid: customerId })
      .select([
        's.id AS id',
        's.name_ar AS "nameAr"',
        's.name_en AS "nameEn"',
        's.color AS color',
      ])
      .orderBy('s.name_ar', 'ASC')
      .getRawMany<CustomerSegmentTag>();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private count(segmentId: string): Promise<number> {
    return this.members.count({ where: { segmentId } });
  }

  private async memberCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.members
      .createQueryBuilder('m')
      .select('m.segment_id', 'segmentId')
      .addSelect('COUNT(*)', 'count')
      .where('m.segment_id IN (:...ids)', { ids })
      .groupBy('m.segment_id')
      .getRawMany<{ segmentId: string; count: string }>();
    return new Map(rows.map((r) => [r.segmentId, Number(r.count)]));
  }

  private toView(s: CustomerSegment, memberCount: number): SegmentView {
    return {
      id: s.id,
      nameAr: s.nameAr,
      nameEn: s.nameEn ?? null,
      description: s.description ?? null,
      color: s.color ?? null,
      kind: s.kind,
      rules: s.rules ?? null,
      isActive: s.isActive,
      isSystem: s.isSystem,
      memberCount,
      createdAt: s.createdAt,
    };
  }
}
