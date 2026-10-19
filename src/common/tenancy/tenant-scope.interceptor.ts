import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, from, lastValueFrom } from 'rxjs';

import { TenantScope } from './tenant-scope.service';
import { UserContextService } from '../context/user-context.service';
import { DEFAULT_TENANT_ID } from '../constants/tenancy';

/**
 * Binds every request to its tenant before the handler runs.
 *
 * THE LOGIN PROBLEM
 * `POST /auth/login` has no token yet — that is the point of it — so there is
 * no tenant on the context. With row-level security on and nothing bound, the
 * users lookup matches zero rows and every login fails with "invalid
 * credentials". Authentication has to read the users table *before* anyone
 * knows which company the caller belongs to.
 *
 * There is no clever fix, because on a shared deployment the question is
 * genuinely ambiguous: `user_number` is only unique per company now, so five
 * companies can each have an `admin` and a bare username identifies none of
 * them. Resolving that needs an identity that is unique across companies — an
 * email, which is what the CRM issues tokens against — or a device already
 * bound to a company. Both are the CRM login path.
 *
 * So the fallback below is deliberately scoped to the case where the question
 * has only one possible answer: a SINGLE-COMPANY install, where every row
 * belongs to the default tenant anyway. That is the on-premise deployment and
 * the local dev box, and it keeps them behaving exactly as they did before
 * tenancy existed.
 *
 * On a shared deployment set `TENANT_FALLBACK_ENABLED=false`. Untenanted
 * requests then see nothing, and dashboard users authenticate through the CRM.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  private readonly fallbackEnabled: boolean;

  constructor(
    private readonly userCtx: UserContextService,
    private readonly scope: TenantScope,
    config: ConfigService,
  ) {
    this.fallbackEnabled =
      config.get<boolean>('tenantFallbackEnabled') !== false;
  }

  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId =
      this.userCtx.getTenantId() ??
      (this.fallbackEnabled ? DEFAULT_TENANT_ID : null);

    if (!tenantId) return next.handle();

    // The handler runs inside the transaction, so a thrown error rolls the
    // whole request back — which is what the voucher write path already
    // expects from its own explicit transaction.
    return from(
      this.scope.runWith(tenantId, () => lastValueFrom(next.handle())),
    );
  }
}
