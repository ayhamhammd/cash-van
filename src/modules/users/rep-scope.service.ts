import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserRepScope } from './entities/user-rep-scope.entity';
import { User } from './entities/user.entity';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Answers one question for the whole dashboard: which salesmen may this user see?
 *
 * See docs/SPEC-rep-scoped-users.md. The contract that matters:
 *
 *   null      → unrestricted, apply NO filter
 *   string[]  → exactly these rep ids, possibly EMPTY
 *
 * An empty array means "sees nothing" and must produce an empty result. That is
 * why unrestricted is `null` and not `[]` — if both were arrays, a call site
 * that did `if (ids.length) applyFilter()` would silently hand a scoped user with
 * no assignments the entire company's data. The types make that mistake loud.
 */
@Injectable()
export class RepScopeService {
  constructor(
    @InjectRepository(UserRepScope)
    private readonly scope: Repository<UserRepScope>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /** The rep ids this user may see, or null when unrestricted. */
  async visibleRepIds(user: AuthenticatedUser): Promise<string[] | null> {
    // A salesman is always scoped to themselves, whatever the mode says.
    if (user.repId) return [user.repId];

    const row = await this.users.findOne({
      where: { id: user.sub },
      select: { id: true, repScopeMode: true },
    });
    if (row?.repScopeMode !== 'assigned') return null;

    const rows = await this.scope.find({
      where: { userId: user.sub },
      select: { repId: true },
    });
    return rows.map((r) => r.repId);
  }

  /**
   * Throw unless the user may see this rep. For endpoints that act on ONE rep —
   * settling a day, approving a request, opening a rep's page — where filtering
   * a list is not the right shape and silently returning nothing would read as
   * "no data" rather than "not yours".
   */
  async assertCanSeeRep(user: AuthenticatedUser, repId: string): Promise<void> {
    const visible = await this.visibleRepIds(user);
    if (visible === null) return;
    if (!visible.includes(repId)) {
      throw new ForbiddenException('This salesman is outside your assigned scope');
    }
  }

  /** Replace a user's assigned salesmen wholesale. */
  async setScope(userId: string, repIds: string[]): Promise<void> {
    await this.scope.delete({ userId });
    const unique = [...new Set(repIds)];
    if (unique.length === 0) return;
    await this.scope.insert(unique.map((repId) => ({ userId, repId })));
  }

  async getScope(userId: string): Promise<string[]> {
    const rows = await this.scope.find({
      where: { userId },
      select: { repId: true },
    });
    return rows.map((r) => r.repId);
  }
}
