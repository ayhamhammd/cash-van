import { ApiProperty } from '@nestjs/swagger';

/**
 * Shared success envelope — produced by TransformInterceptor for every 2xx
 * response. `data` is the endpoint-specific payload (typed per endpoint).
 */
export class ApiSuccessEnvelopeDto<T = unknown> {
  @ApiProperty({ example: true, description: 'Always true for 2xx responses' })
  success!: true;

  @ApiProperty({ description: 'Endpoint-specific payload' })
  data!: T;

  @ApiProperty({
    example: '2026-05-23T10:15:30.000Z',
    description: 'ISO-8601 server timestamp',
  })
  timestamp!: string;
}

/**
 * Shared error envelope — produced by HttpExceptionFilter for every non-2xx
 * response. Identical shape across the whole API.
 */
export class ApiErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP status code' })
  statusCode!: number;

  @ApiProperty({
    description:
      'Human-readable message. A string for most errors; an array of strings for validation failures.',
    oneOf: [
      { type: 'string', example: 'Resource not found' },
      {
        type: 'array',
        items: { type: 'string' },
        example: ['quantity must not be less than 1'],
      },
    ],
  })
  message!: string | string[];

  @ApiProperty({ example: 'BadRequestError', description: 'Error class / code' })
  error!: string;

  @ApiProperty({
    example: '/api/v1/invoices/123',
    description: 'Request path that produced the error',
  })
  path!: string;

  @ApiProperty({
    example: '2026-05-23T10:15:30.000Z',
    description: 'ISO-8601 server timestamp',
  })
  timestamp!: string;
}
