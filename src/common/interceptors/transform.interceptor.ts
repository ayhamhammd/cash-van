import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: true;
  data: T;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    _: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) =>
        // Streamed file downloads must not be wrapped in the JSON envelope.
        data instanceof StreamableFile
          ? (data as unknown as ApiResponse<T>)
          : {
              success: true,
              data,
              timestamp: new Date().toISOString(),
            },
      ),
    );
  }
}
