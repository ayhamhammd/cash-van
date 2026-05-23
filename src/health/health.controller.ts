import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators/public.decorator';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Health check',
    description: 'Public liveness/readiness probe. Reports overall status and database connectivity.',
  })
  @ApiOkResponse({ description: 'Health status (status + db)' })
  async check(): Promise<{ status: 'ok' | 'degraded'; db: 'up' | 'down' }> {
    let db: 'up' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', db };
  }
}
