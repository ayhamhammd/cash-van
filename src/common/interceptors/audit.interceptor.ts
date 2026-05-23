import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';

import { AuditLog } from '../../modules/system/entities/audit-log.entity';
import { SKIP_AUDIT_KEY } from '../decorators/skip-audit.decorator';
import { UserContextService } from '../context/user-context.service';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface ReqUser {
  sub?: string;
}

/**
 * Global interceptor that records every successful mutating request in
 * `audit_log`. Best-effort: a failure to write the audit row never breaks the
 * request. GETs are ignored; routes can opt out with @SkipAudit().
 *
 * `entity` = first path segment after the version (e.g. /api/v1/customers/:id
 * → "customers"); `entity_id` = route :id or the created resource id; `action`
 * = create (collection POST) / update (PATCH/PUT or POST with :id) / delete.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    private readonly reflector: Reflector,
    private readonly userCtx: UserContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: ReqUser }>();
    const method = req.method?.toUpperCase();

    if (!MUTATING.has(method)) return next.handle();
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }

    return next.handle().pipe(
      tap((result) => {
        // Fire-and-forget; never block or fail the response.
        void this.write(req, method, result).catch((err) =>
          this.logger.warn(`audit write failed: ${(err as Error).message}`),
        );
      }),
    );
  }

  private async write(
    req: Request & { user?: ReqUser },
    method: string,
    result: unknown,
  ): Promise<void> {
    const segments = req.path.replace(/^\/api\/v\d+\//, '').split('/').filter(Boolean);
    const entity = segments[0] ?? 'unknown';
    const paramId = (req.params as Record<string, string> | undefined)?.id;
    // The response may be the raw entity OR the {success,data,timestamp} envelope.
    const payload =
      result && typeof result === 'object' && 'data' in result
        ? (result as { data: unknown }).data
        : result;
    const resultId =
      payload && typeof payload === 'object' && 'id' in payload
        ? String((payload as { id: unknown }).id)
        : undefined;
    const entityId = paramId ?? resultId ?? '(collection)';

    let action: string;
    if (method === 'DELETE') action = 'delete';
    else if (method === 'POST' && !paramId) action = 'create';
    else action = 'update';

    const diff =
      method === 'DELETE'
        ? null
        : ({ body: this.redact(req.body as Record<string, unknown>) } as Record<string, unknown>);

    await this.audit.save(
      this.audit.create({
        actorId: this.userCtx.getUserId() ?? req.user?.sub ?? null,
        entity,
        entityId,
        action,
        diffJson: diff,
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }),
    );
  }

  /** Strip obvious secrets from the recorded request body. */
  private redact(body: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!body || typeof body !== 'object') return {};
    const SENSITIVE = ['password', 'secretKey', 'secret', 'token', 'passwordHash'];
    const copy: Record<string, unknown> = { ...body };
    for (const k of Object.keys(copy)) {
      if (SENSITIVE.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
        copy[k] = '***';
      }
    }
    return copy;
  }
}
