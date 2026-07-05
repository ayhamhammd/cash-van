import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ErpSyncService } from './erp-sync.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpOutboxStatus } from './entities/erp-outbox.entity';
import { Public } from '../../common/decorators/public.decorator';
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

  @Post('webhook')
  @Public()
  @ApiOperation({
    summary: 'ERP change webhook (push)',
    description:
      'Called by the ERP the moment any synced data changes (stock, items, customers, stores, org). Authenticated by the shared ERP_WEBHOOK_SECRET header, NOT a JWT. Schedules an immediate debounced inbound pull and returns 200 at once.',
  })
  @ApiOkResponse({ description: 'Accepted' })
  webhook(@Headers('x-webhook-secret') secret?: string): { accepted: boolean } {
    const expected = process.env.ERP_WEBHOOK_SECRET;
    if (!expected || secret !== expected) {
      throw new ForbiddenException('Invalid webhook secret');
    }
    this.sync.triggerWebhookSync();
    return { accepted: true };
  }

  @Post('sync/refresh')
  @ApiOperation({
    summary: 'Full master-data refresh from the ERP',
    description:
      'Re-pulls all company info, stores, items (incl. old + price/cost) and customers from the ERP (full, not incremental). Admin only.',
  })
  @ApiOkResponse({ description: 'Per-entity results' })
  refresh() {
    return this.sync.refreshAll();
  }

  @Get('sync/status')
  @ApiOperation({ summary: 'ERP sync status', description: 'Per-entity cursor + last run. Admin only.' })
  @ApiOkResponse({ description: 'Sync cursors' })
  status() {
    return this.sync.status();
  }

  @Get('export/pending')
  @ApiOperation({
    summary: 'Pending manual exports',
    description:
      'Posted vouchers (sale/return/order/transfer/in/out) + confirmed collections not yet pushed to the ERP. Used when direct export is OFF. Admin only.',
  })
  @ApiOkResponse({ description: 'Pending vouchers + collections' })
  pendingExports() {
    return this.sync.listPendingExports();
  }

  @Post('export/all')
  @ApiOperation({
    summary: 'Export all pending',
    description: 'Queue every pending voucher + collection for ERP push. Admin only.',
  })
  @ApiOkResponse({ description: 'Counts queued' })
  exportAll() {
    return this.sync.exportAllPending();
  }

  @Post('export/voucher/:voucherNumber')
  @ApiOperation({ summary: 'Export one voucher to the ERP', description: 'Admin only.' })
  @ApiOkResponse({ description: 'Queued' })
  exportVoucher(@Param('voucherNumber') voucherNumber: string) {
    return this.sync.exportVoucher(voucherNumber);
  }

  @Post('export/collection/:id')
  @ApiOperation({ summary: 'Export one collection to the ERP', description: 'Admin only.' })
  @ApiOkResponse({ description: 'Queued' })
  exportCollection(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.exportCollection(id);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List ERP categories', description: 'Passthrough for the item form. Admin only.' })
  erpCategories() {
    return this.sync.listErpCategories();
  }

  @Get('tax-rates')
  @ApiOperation({ summary: 'List ERP tax rates', description: 'Passthrough for the item form. Admin only.' })
  erpTaxRates() {
    return this.sync.listErpTaxRates();
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
