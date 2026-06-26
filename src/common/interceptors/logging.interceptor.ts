import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** Redact secrets before logging a body. */
function redact(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const SECRET = /password|apikey|api_key|secret|token|authorization/i;
  const out: Record<string, unknown> = Array.isArray(v) ? ([] as never) : {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET.test(k) ? '***' : redact(val);
  }
  return out;
}

function brief(v: unknown, max = 2000): string {
  let s: string;
  try {
    s = JSON.stringify(redact(v));
  } catch {
    s = String(v);
  }
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…(${s.length}b)` : s;
}

/**
 * Logs every API request + response: method, url, request body, status,
 * response body (redacted + truncated) and duration. Registered globally.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('API');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url?: string;
      body?: unknown;
      query?: unknown;
    }>();
    const method = req.method;
    const url = req.originalUrl ?? req.url ?? '';
    const start = Date.now();
    const reqBody =
      req.body && Object.keys(req.body as object).length ? ` body=${brief(req.body)}` : '';
    this.logger.log(`→ ${method} ${url}${reqBody}`);

    return next.handle().pipe(
      tap({
        next: (data) =>
          this.logger.log(`← ${method} ${url} ${Date.now() - start}ms res=${brief(data)}`),
        error: (err: { status?: number; message?: string }) =>
          this.logger.warn(
            `✗ ${method} ${url} ${Date.now() - start}ms ${err?.status ?? ''} ${err?.message ?? err}`,
          ),
      }),
    );
  }
}
