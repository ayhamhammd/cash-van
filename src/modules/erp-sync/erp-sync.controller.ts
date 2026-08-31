import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

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
    summary: 'Start an inbound catalog pull',
    description:
      'Starts a FAST sweep (organization, warehouses, categories, units, tobacco ' +
      'profiles, items, customers, price lists, per-store stock movements, receipts) ' +
      'in the background and returns immediately — a full sweep takes minutes and ' +
      'used to time the caller out. Poll GET /erp/sync/status for progress. The ' +
      'heavy per-customer price pull is excluded here; it runs nightly and from its ' +
      'own row button. No-op when ERP mode is off. Admin only.',
  })
  @ApiAcceptedResponse({ description: '{ started: true } — watch /erp/sync/status' })
  @HttpCode(HttpStatus.ACCEPTED)
  syncNow() {
    return this.sync.startFullSync();
  }

  @Post('sync/entity/:entity')
  @ApiOperation({
    summary: 'Re-run ONE sync step',
    description:
      'Runs a single entity on its own — the per-row button in Settings → ERP. Use ' +
      'it to retry a step that failed without re-running the whole catalogue, or to ' +
      'pull `customer_price` on demand (it is excluded from the 5-minute sweep ' +
      'because it costs one ERP call per customer). Accepts any name from ' +
      'GET /erp/sync/entities, including `movements:<storeCode>`. Runs in the ' +
      'background; poll GET /erp/sync/status. Admin only.',
  })
  @ApiAcceptedResponse({ description: '{ started: true } — watch /erp/sync/status' })
  @HttpCode(HttpStatus.ACCEPTED)
  syncEntity(@Param('entity') entity: string) {
    return this.sync.startEntity(entity);
  }

  @Get('sync/entities')
  @ApiOperation({
    summary: 'Syncable entity names',
    description: 'Every name POST /erp/sync/entity/:entity accepts, with its tier. Admin only.',
  })
  @ApiOkResponse({ description: 'Entity names + tier' })
  syncEntities() {
    return this.sync.syncableEntities();
  }

  @Get('sync/activity')
  @ApiOperation({
    summary: 'What is running right now',
    description: 'The in-flight sweep (if any) and the entities currently pulling. Admin only.',
  })
  @ApiOkResponse({ description: 'Live sync activity' })
  syncActivity() {
    return this.sync.syncActivity();
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
      'Re-pulls all company info, stores, items (incl. old + price/cost), customers, ' +
      'price lists AND per-customer prices from the ERP (full, not incremental). ' +
      'Runs in the background and returns immediately. Admin only.',
  })
  @ApiAcceptedResponse({ description: '{ started: true } — watch /erp/sync/status' })
  @HttpCode(HttpStatus.ACCEPTED)
  refresh() {
    return this.sync.startRefresh();
  }

  @Get('sync/status')
  @ApiOperation({ summary: 'ERP sync status', description: 'Per-entity cursor + last run. Admin only.' })
  @ApiOkResponse({ description: 'Sync cursors' })
  status() {
    return this.sync.status();
  }

  @Get('sync/drift')
  @ApiOperation({
    summary: 'Stock drift: ERP snapshot vs cash-van on-hand',
    description:
      "Read-only. Pulls the ERP's absolute /van/stock snapshot and compares it, " +
      'per (store, item, pool), against cash-van\'s computed balance, listing every ' +
      'divergence and by how much. Writes nothing. Admin only. See ' +
      'docs/PLAN-erp-sync-reconciliation.md.',
  })
  @ApiOkResponse({ description: 'Drift report' })
  drift() {
    return this.sync.computeStockDrift();
  }

  @Post('sync/movements/catch-up')
  @ApiOperation({
    summary: 'Skip stock-movement history (post API-key switch)',
    description:
      'Seeds every movements:* cursor to now so the next pull ignores past movements. Run ONCE right after moving the ERP API key to a dedicated integration user, to avoid re-mirroring history and double-counting stock. Admin only.',
  })
  @ApiOkResponse({ description: 'Seeded cursors + timestamp' })
  catchUpMovements() {
    return this.sync.catchUpMovements();
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

  @Get('chart-of-accounts')
  @ApiOperation({
    summary: 'List ERP GL accounts',
    description: 'Postable (leaf) chart-of-accounts entries for linking rep cash boxes. Admin only.',
  })
  erpChartOfAccounts() {
    return this.sync.listErpChartOfAccounts();
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
