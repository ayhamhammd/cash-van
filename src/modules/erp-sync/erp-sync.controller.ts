import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ErpSyncService } from './erp-sync.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpOutboxStatus } from './entities/erp-outbox.entity';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('erp-sync')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin')
@Controller({ path: 'erp', version: '1' })
export class ErpSyncController {
  constructor(
    private readonly sync: ErpSyncService,
    private readonly outbox: ErpOutboxService,
  ) {}

  @Post('sync/now')
  @ApiOperation({
    summary: 'Pull the ERP catalog now',
    description: 'Runs an inbound pull (items so far). No-op when ERP mode is off. Admin only.',
  })
  @ApiOkResponse({ description: 'Per-entity results' })
  syncNow() {
    return this.sync.syncNow();
  }

  @Get('sync/status')
  @ApiOperation({ summary: 'ERP sync status', description: 'Per-entity cursor + last run. Admin only.' })
  @ApiOkResponse({ description: 'Sync cursors' })
  status() {
    return this.sync.status();
  }

  @Get('outbox')
  @ApiOperation({ summary: 'Outbound queue', description: 'Van docs queued/failed for the ERP. Admin only.' })
  @ApiOkResponse({ description: 'Outbox rows' })
  outboxList(@Query('status') status?: ErpOutboxStatus) {
    return this.outbox.list(status);
  }

  @Post('outbox/:id/retry')
  @ApiOperation({ summary: 'Retry an outbound push', description: 'Re-attempt one queued/failed/dead-letter row. Admin only.' })
  @ApiOkResponse({ description: 'The updated outbox row' })
  outboxRetry(@Param('id', ParseUUIDPipe) id: string) {
    return this.outbox.retry(id);
  }
}
