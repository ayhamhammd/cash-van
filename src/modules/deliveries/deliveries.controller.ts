import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissionKeys } from '../../common/decorators/permissions.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  PERM_DELIVERIES_APPROVE_RETURN,
  PERM_DELIVERIES_MANAGE,
  PERM_DELIVERIES_VIEW,
} from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { DeliveryReturnsService } from './delivery-returns.service';
import { DeliveryIncreasesService } from './delivery-increases.service';
import { DeliveryReturnVoucherService } from './delivery-return-voucher.service';
import { DeliveriesService } from './deliveries.service';
import { streamProof } from './deliveries-app.controller';
import { DeliveryProofsService } from './delivery-proofs.service';
import {
  ApproveReturnDto,
  CreateRunDto,
  DismissIncreaseDto,
  ListIncreasesQuery,
  OrderIncreaseDto,
  ListReturnsQuery,
  ListRunsQuery,
  LoadableInvoicesQuery,
  PatchRunDto,
  RejectReturnDto,
} from './dto/deliveries.dto';

/**
 * Delivery runs, for the office (docs/SPEC-delivery-rep.md §6.2).
 *
 * Reads come from the mirror. Writes go to the ERP live, then the run is
 * re-read into the mirror and answered from it. An ERP refusal comes back with
 * the ERP's code (422 LOAD_REFUSED with `refusals`, 409 RUN_CLOSED, …); an ERP
 * that cannot be reached is 503 ERP_UNAVAILABLE.
 */
@ApiTags('deliveries')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'deliveries', version: '1' })
export class DeliveriesController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly proofs: DeliveryProofsService,
    private readonly returns: DeliveryReturnsService,
    private readonly increases: DeliveryIncreasesService,
    private readonly returnVouchers: DeliveryReturnVoucherService,
  ) {}

  // ── increase requests (phase 4) ─────────────────────────────────────────

  @Get('increases')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'Increase requests from deliveries (PENDING by default, DECIDED, ALL)' })
  @ApiOkResponse({ description: '{ items: IncreaseRequest[], total }' })
  listIncreases(@Query() q: ListIncreasesQuery) {
    return this.increases.list(q);
  }

  @Get('increases/count')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'Pending increase requests, for the badge' })
  @ApiOkResponse({ description: '{ pending }' })
  countIncreases() {
    return this.increases.count();
  }

  @Post('increases/:id/order')
  @RequirePermissionKeys(PERM_DELIVERIES_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Turn an increase request into an ORDER voucher for its customer',
    description:
      'Through the vouchers service (pricing, tax mode, exemption, offers, ERP SALES_ORDER). ' +
      'Send an Idempotency-Key header: the same key answers the same order. 409 ' +
      'INCREASE_ALREADY_DECIDED; 422 with the voucher service\'s own code.',
  })
  @ApiOkResponse({ description: '{ request: IncreaseRequest, order: { id, voucherNumber, totalFils } }' })
  orderIncrease(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrderIncreaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.increases.order(id, dto, user, idempotencyKey);
  }

  @Post('increases/:id/dismiss')
  @RequirePermissionKeys(PERM_DELIVERIES_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss an increase request (note required)' })
  @ApiOkResponse({ description: '{ request: IncreaseRequest }' })
  dismissIncrease(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissIncreaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.increases.dismiss(id, dto, user, idempotencyKey);
  }

  // ── delivery returns (phase 3) ──────────────────────────────────────────

  @Get('returns')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'The delivery-returns queue (PENDING by default, DECIDED, ALL)' })
  @ApiOkResponse({ description: '{ items: ReturnRequest[], total }' })
  listReturns(@Query() q: ListReturnsQuery) {
    return this.returns.list(q);
  }

  @Get('returns/count')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'Pending delivery returns, for the badge' })
  @ApiOkResponse({ description: '{ pending }' })
  countReturns() {
    return this.returns.count();
  }

  @Post('returns/:stopId/approve')
  @RequirePermissionKeys(PERM_DELIVERIES_APPROVE_RETURN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Approve a stop's return on the ERP; it issues the credit note",
    description:
      'Send an Idempotency-Key header per click (passed to the ERP). ERP refusals pass through ' +
      'with their code: 409 RETURN_ALREADY_DECIDED, 422 NOTHING_TO_RETURN / QTY_OUT_OF_RANGE / ' +
      'NO_DAMAGED_WAREHOUSE. 503 ERP_UNAVAILABLE.',
  })
  @ApiOkResponse({
    description:
      '{ stop: Stop, creditNote: { number, totalFils, jofotaraStatus, qr } | null, returnVoucher: { id, voucherNumber } | null }',
  })
  approveReturn(
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: ApproveReturnDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.returns.approve(stopId, dto, user, idempotencyKey);
  }

  @Post('returns/backfill-vouchers')
  @RequirePermissionKeys(PERM_DELIVERIES_APPROVE_RETURN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Write the CashVan RETURN voucher of every approved delivery return that has none (idempotent)',
    description:
      'The one-off for returns approved before the vouchers existed. Safe to run again: a return ' +
      'that has its voucher is left alone. Never pushes anything to the ERP.',
  })
  @ApiOkResponse({ description: '{ total, created, existing, skipped: [{ stopId, reason }] }' })
  backfillReturnVouchers() {
    return this.returnVouchers.backfill();
  }

  @Post('returns/:stopId/reject')
  @RequirePermissionKeys(PERM_DELIVERIES_APPROVE_RETURN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reject a stop's return on the ERP (note required)" })
  @ApiOkResponse({ description: '{ stop: Stop }' })
  rejectReturn(
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: RejectReturnDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.returns.reject(stopId, dto, user, idempotencyKey);
  }

  @Get('runs')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'Delivery runs (filter by date, rep, status)' })
  @ApiOkResponse({ description: '{ items: RunSummary[] }' })
  list(@Query() q: ListRunsQuery) {
    return this.deliveries.listRuns(q);
  }

  @Get('runs/:id')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'One run with its stops and lines' })
  @ApiOkResponse({ description: 'RunDetail & { goodsBack: [{ skuCode, nameAr, nameEn, unit, qty }] }' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.runDetail(id);
  }

  @Post('runs')
  @RequirePermissionKeys(PERM_DELIVERIES_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Build a run on the ERP from invoices' })
  @ApiOkResponse({ description: 'RunDetail & { warnings: [{ invoiceNumber, code }] }' })
  create(@Body() dto: CreateRunDto) {
    return this.deliveries.createRun(dto);
  }

  @Patch('runs/:id')
  @RequirePermissionKeys(PERM_DELIVERIES_MANAGE)
  @ApiOperation({ summary: 'Add or remove invoices, re-order, change rep, vehicle or notes' })
  @ApiOkResponse({ description: 'RunDetail & { warnings: [{ invoiceNumber, code }] }' })
  patch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchRunDto) {
    return this.deliveries.patchRun(id, dto);
  }

  @Post('runs/:id/close')
  @RequirePermissionKeys(PERM_DELIVERIES_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a run (every stop must have a result)' })
  @ApiOkResponse({ description: 'RunDetail' })
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.closeRun(id);
  }

  @Get('loadable-invoices')
  @RequirePermissionKeys(PERM_DELIVERIES_MANAGE)
  @ApiOperation({ summary: 'ERP invoices that can go on a run (from the invoice mirror)' })
  @ApiOkResponse({ description: '{ items: LoadableInvoice[], total }' })
  loadable(@Query() q: LoadableInvoicesQuery) {
    return this.deliveries.loadableInvoices(q);
  }

  @Get('vehicles')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: "The ERP's active vehicles" })
  @ApiOkResponse({ description: '{ items: [{ erpId, name, plateNumber }] }' })
  vehicles() {
    return this.deliveries.vehicles();
  }

  @Get('stops/:stopId/proofs/:proofId')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: 'A delivery proof (photo or signature), streamed with its Content-Type' })
  async proof(
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Param('proofId', ParseUUIDPipe) proofId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return streamProof(res, await this.proofs.file(stopId, proofId, 'dashboard'));
  }

  @Get('stops/by-invoice/:invoiceNumber')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: "An invoice's delivery stop, with its run" })
  @ApiOkResponse({ description: 'Stop & { run: { id, runNumber, runDate, status, rep } }' })
  byInvoice(@Param('invoiceNumber') invoiceNumber: string) {
    return this.deliveries.stopByInvoice(invoiceNumber);
  }
}
