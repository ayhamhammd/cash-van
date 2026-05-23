import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from './entities/audit-log.entity';
import { AuditQueryDto } from './dto/audit-query.dto';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
  ) {}

  async query(q: AuditQueryDto): Promise<{ items: AuditLog[]; total: number }> {
    const qb = this.audit
      .createQueryBuilder('a')
      .orderBy('a.acted_at', 'DESC')
      .take(q.limit ?? 50)
      .skip(q.offset ?? 0);
    if (q.entity) qb.andWhere('a.entity = :e', { e: q.entity });
    if (q.entityId) qb.andWhere('a.entity_id = :eid', { eid: q.entityId });
    if (q.actorId) qb.andWhere('a.actor_id = :aid', { aid: q.actorId });
    if (q.from) qb.andWhere('a.acted_at >= :from', { from: q.from });
    if (q.to) qb.andWhere('a.acted_at <= :to', { to: q.to });
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async forEntity(entity: string, entityId: string): Promise<AuditLog[]> {
    return this.audit.find({
      where: { entity, entityId },
      order: { actedAt: 'DESC' },
      take: 200,
    });
  }
}
