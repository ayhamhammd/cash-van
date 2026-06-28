import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentBuilder,
  SwaggerModule,
  getSchemaPath,
  type OpenAPIObject,
} from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import {
  ApiErrorResponseDto,
  ApiSuccessEnvelopeDto,
} from './common/dto/api-response.dto';

/**
 * Inject the shared error envelope into every operation so the contract
 * ("one error response across all APIs") is visible in Swagger without
 * repeating @ApiResponse on every handler. Only adds codes a handler hasn't
 * already documented itself.
 */
function applyStandardErrorResponses(doc: OpenAPIObject): void {
  const schema = { $ref: getSchemaPath(ApiErrorResponseDto) };
  const json = (description: string) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const standard: Record<string, ReturnType<typeof json>> = {
    '400': json('Validation failed / malformed request'),
    '401': json('Missing or invalid bearer token'),
    '403': json('Authenticated but not permitted for this action'),
    '404': json('Resource not found'),
    '409': json('Conflict (e.g. duplicate unique value)'),
    '500': json('Unexpected server error'),
  };

  for (const path of Object.values(doc.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const op = (path as Record<string, unknown>)[method] as
        | { responses?: Record<string, unknown> }
        | undefined;
      if (!op?.responses) continue;
      for (const [code, body] of Object.entries(standard)) {
        if (!op.responses[code]) op.responses[code] = body;
      }
    }
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.use(compression());

  const origins = config.get<string>('cors.origins', '*');
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((s) => s.trim()),
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

  // Swagger is on outside production, or in production when explicitly opted
  // in via SWAGGER_ENABLED=true (so docs can be exposed without weakening
  // production security/validation behaviour).
  const swaggerEnabled =
    config.get<string>('nodeEnv') !== 'production' ||
    process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    const swaggerCfg = new DocumentBuilder()
      .setTitle('VanFlow API')
      .setDescription(
        [
          'Cash-van mobile-sales backend.',
          '',
          '**Auth:** all endpoints (except `POST /auth/login`) require a bearer JWT — click **Authorize** and paste the `accessToken` from login.',
          '',
          '**Success envelope:** every 2xx response is wrapped as `{ success: true, data, timestamp }`. The `data` field holds the payload documented per endpoint.',
          '',
          '**Error envelope:** every non-2xx response is `{ statusCode, message, error, path, timestamp }` (the `ApiErrorResponseDto` schema). The standard 400/401/403/404/409/500 responses are listed on every operation.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'bearer',
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerCfg, {
      extraModels: [ApiErrorResponseDto, ApiSuccessEnvelopeDto],
    });
    applyStandardErrorResponses(document);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
        docExpansion: 'none',
      },
    });
  }

  app.enableShutdownHooks();

  const port = config.get<number>('port', 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Cash Van API listening on http://0.0.0.0:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
