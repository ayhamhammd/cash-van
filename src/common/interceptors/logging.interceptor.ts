import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

/**
 * One access-log line per HTTP request: `METHOD url status duration`. Errors
 * (4xx/5xx) are logged with their stack by HttpExceptionFilter, so this only
 * logs completed (non-throwing) responses to avoid double reporting. Health
 * checks are skipped — Render pings them constantly and they'd drown the log.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (req.url.includes('/health')) return next.handle();

    const start = Date.now();
    const { method, url } = req;
    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - start;
        this.logger.log(`${method} ${url} ${res.statusCode} ${ms}ms`);
      }),
    );
  }
}
