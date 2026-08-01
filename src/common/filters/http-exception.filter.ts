import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { Request, Response } from 'express';

import { BODY_LIMIT } from '../constants/body-limit';

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  path: string;
  timestamp: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, error } = this.mapException(exception);

    const body: ErrorBody = {
      statusCode: status,
      message,
      error,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${error}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status} ${error}`);
    }

    response.status(status).json(body);
  }

  private mapException(exception: unknown): {
    status: number;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const status = exception.getStatus();
      if (typeof res === 'string') {
        return { status, message: res, error: exception.name };
      }
      const obj = res as Record<string, unknown>;
      return {
        status,
        message: (obj.message as string | string[]) ?? exception.message,
        error: (obj.error as string) ?? exception.name,
      };
    }

    // body-parser failures are plain Errors carrying an HTTP-ish `status`.
    // Without this they fall through to the catch-all and surface as an opaque
    // 500 — most often "request entity too large" on a big logo upload.
    if (exception instanceof Error && 'type' in exception) {
      const bp = exception as Error & { type?: string; status?: number };
      if (bp.type === 'entity.too.large') {
        return {
          status: HttpStatus.PAYLOAD_TOO_LARGE,
          message: `Request body is too large (limit ${BODY_LIMIT}). Use a smaller image.`,
          error: 'PayloadTooLargeError',
        };
      }
      if (bp.type === 'entity.parse.failed') {
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'Request body is not valid JSON',
          error: 'BadRequestError',
        };
      }
    }

    if (exception instanceof QueryFailedError) {
      const driverErr = exception as QueryFailedError & { code?: string };
      if (driverErr.code === '23505') {
        return {
          status: HttpStatus.CONFLICT,
          message: 'Duplicate value violates unique constraint',
          error: 'ConflictError',
        };
      }
      if (driverErr.code === '23503') {
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'Foreign key constraint violation',
          error: 'BadRequestError',
        };
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Database query failed',
        error: 'QueryFailedError',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
    };
  }
}
