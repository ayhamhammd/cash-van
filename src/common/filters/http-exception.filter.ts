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
