import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

export interface UserContext {
  userId: string;
  role: string;
}

export const USER_CTX_KEY = 'userCtx';

/**
 * Reads/writes the per-request user context stored in CLS (AsyncLocalStorage).
 *
 * Used by:
 *   - Audit log interceptor (plan 09) — records `actor_id` on writes
 *   - Background job processors — re-establishes the user that triggered the job
 *
 * Lifecycle:
 *   1. JwtStrategy.validate() → set(...) after token verification.
 *   2. Service / interceptor / job code → reads via get*().
 */
@Injectable()
export class UserContextService {
  constructor(private readonly cls: ClsService) {}

  set(ctx: UserContext): void {
    this.cls.set(USER_CTX_KEY, ctx);
  }

  get(): UserContext | null {
    return this.cls.get<UserContext | undefined>(USER_CTX_KEY) ?? null;
  }

  getUserId(): string | null {
    return this.get()?.userId ?? null;
  }

  getRole(): string | null {
    return this.get()?.role ?? null;
  }

  /**
   * Run `fn` inside a CLS scope populated with the given user context.
   * Used by background-job processors and CLI scripts that have no HTTP request.
   */
  runWith<T>(ctx: UserContext, fn: () => Promise<T> | T): Promise<T> {
    return this.cls.runWith(
      { [USER_CTX_KEY]: ctx } as Record<string, unknown>,
      fn,
    ) as Promise<T>;
  }
}
