import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import { Repository } from 'typeorm';

import { Rep } from '../../modules/reps/entities/rep.entity';
import { SupervisorRep } from '../../modules/users/entities/supervisor-rep.entity';
import { UserContextService } from '../context/user-context.service';
import { EMPTY_SCOPE, Scope } from './scope.types';

/** Per-request memo key. One resolution serves a report touching six tables. */
export const SCOPE_CTX_KEY = 'dataScope';

/**
 * Resolves *whose* data the current request may touch.
 *
 * One service, one method, one meaning — every scoped query consumes this and
 * nothing re-derives it. Rules, in order (docs/SPEC-supervisor-scoping.md §5):
 *
 *   1. role === 'admin'                  -> ALL (main admin, unfiltered)
 *   2. has rows in `supervisor_reps`     -> REPS with those ids
 *   3. is themselves a rep               -> REPS with just their own id
 *   4. otherwise                         -> REPS with an empty list
 *
 * Rule 4 is the important one: **deny by default**. A user who should be scoped
 * but has no assignment yet sees an empty dashboard, never the whole company.
 * The opposite default is the kind of mistake that only surfaces after a leak.
 *
 * Rule 3 keeps the mobile app working. A salesman's login is not an admin and
 * has no assignment, so rules 1/2/4 alone would resolve them to *nothing* and
 * lock the app out of its own vouchers, stock and collections. Scoping them to
 * their own rep is both what the app needs and strictly tighter than today,
 * where a rep's token can read any rep's data through the dashboard endpoints.
 *
 * Scope is resolved from the DB per request, never from the JWT, so revoking an
 * assignment takes effect immediately instead of at next login.
 */
@Injectable()
export class ScopeService {
  private readonly logger = new Logger(ScopeService.name);

  constructor(
    @InjectRepository(SupervisorRep)
    private readonly links: Repository<SupervisorRep>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    private readonly userCtx: UserContextService,
    private readonly cls: ClsService,
  ) {}

  /**
   * The scope for the user behind the current request, memoised for its
   * lifetime. No identity resolved (no CLS context, unauthenticated path) =>
   * empty scope: fail closed, never fall through to unscoped data.
   */
  async forCurrentUser(): Promise<Scope> {
    if (this.cls.isActive()) {
      const cached = this.cls.get<Scope | undefined>(SCOPE_CTX_KEY);
      if (cached) return cached;
    }

    const ctx = this.userCtx.get();
    if (!ctx) {
      this.logger.warn(
        'scope requested with no user context — denying (empty scope)',
      );
      return EMPTY_SCOPE;
    }

    const scope = await this.forUser(ctx.userId, ctx.role);
    if (this.cls.isActive()) this.cls.set(SCOPE_CTX_KEY, scope);
    return scope;
  }

  /**
   * The pure resolver. Exposed for background jobs and tests, which have a user
   * id but no request.
   */
  async forUser(userId: string, role: string): Promise<Scope> {
    if (role === 'admin') return { kind: 'ALL' };

    const rows = await this.links.find({
      where: { userId },
      select: { repId: true },
    });
    const repIds = [...new Set(rows.map((r) => r.repId))];

    if (repIds.length === 0) {
      // Not a supervisor. If they're a salesman, they get themselves.
      const own = await this.reps.findOne({
        where: { userId },
        select: { id: true },
      });
      if (!own) return EMPTY_SCOPE;
      repIds.push(own.id);
    }

    return { kind: 'REPS', repIds, userCodes: await this.userCodesFor(repIds) };
  }

  /**
   * The `user_number` of each scoped rep's login — the value that lands in
   * `voucher_header.user_code` and its siblings.
   *
   * A rep with no linked user contributes nothing, which is the safe direction:
   * their rows simply stay invisible rather than widening anyone's scope.
   */
  private async userCodesFor(repIds: string[]): Promise<string[]> {
    const rows = await this.reps
      .createQueryBuilder('r')
      .innerJoin('r.user', 'u')
      // withDeleted: an assignment survives a soft-deleted rep, and the
      // supervisor is still meant to see that rep's history. Without this the
      // rep_id half of the scope would keep matching while the user_code half
      // silently stopped.
      .withDeleted()
      .where('r.id IN (:...repIds)', { repIds })
      .select('u.userNumber', 'code')
      .getRawMany<{ code: string | null }>();

    const codes = rows
      .map((r) => r.code)
      .filter((c): c is string => Boolean(c));
    return [...new Set(codes)];
  }
}
