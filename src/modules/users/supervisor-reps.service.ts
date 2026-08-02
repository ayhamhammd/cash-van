import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { UserContextService } from '../../common/context/user-context.service';
import { Rep } from '../reps/entities/rep.entity';
import { SupervisorRep } from './entities/supervisor-rep.entity';
import { User } from './entities/user.entity';

/**
 * Manages which reps a dashboard user supervises.
 *
 * Main-admin only — enforced at the controller. A supervisor who could edit
 * assignments could widen their own scope, which would defeat the feature
 * entirely (docs/SPEC-supervisor-scoping.md §6.3).
 */
@Injectable()
export class SupervisorRepsService {
  constructor(
    @InjectRepository(SupervisorRep)
    private readonly links: Repository<SupervisorRep>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    private readonly userCtx: UserContextService,
    private readonly dataSource: DataSource,
  ) {}

  /** The rep ids currently assigned to `userId`. */
  async list(userId: string): Promise<string[]> {
    await this.mustExist(userId);
    const rows = await this.links.find({
      where: { userId },
      select: { repId: true },
    });
    return rows.map((r) => r.repId);
  }

  /**
   * Replace the whole assignment set. Passing `[]` clears it, which — under
   * deny-by-default — leaves that user seeing nothing rather than everything.
   */
  async replace(userId: string, repIds: string[]): Promise<string[]> {
    const user = await this.mustExist(userId);

    if (user.role === 'admin') {
      throw new BadRequestException(
        `User ${user.userNumber} is a main admin and is never scoped; assigning reps would have no effect. Change their role first.`,
      );
    }

    // One level only (spec §2). A user who is themselves a rep must not also
    // supervise reps, or the hierarchy stops being flat.
    const isRep = await this.reps.exist({ where: { userId } });
    if (isRep) {
      throw new BadRequestException(
        `User ${user.userNumber} is a salesman and cannot supervise other salesmen.`,
      );
    }

    const wanted = [...new Set(repIds)];
    if (wanted.length > 0) {
      const found = await this.reps.find({
        where: { id: In(wanted) },
        select: { id: true },
      });
      const missing = wanted.filter((id) => !found.some((r) => r.id === id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `Unknown rep id(s): ${missing.join(', ')}`,
        );
      }
    }

    const actorId = this.userCtx.getUserId() ?? null;

    // Replace as one unit: a partial apply would silently leave the user with a
    // scope that matches neither the old nor the requested set.
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(SupervisorRep);
      await repo.delete({ userId });
      if (wanted.length > 0) {
        await repo.insert(
          wanted.map((repId) => ({ userId, repId, createdBy: actorId })),
        );
      }
    });

    return wanted;
  }

  private async mustExist(userId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    return user;
  }
}
