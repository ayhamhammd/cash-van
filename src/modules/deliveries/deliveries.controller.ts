import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissionKeys } from '../../common/decorators/permissions.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  PERM_DELIVERIES_MANAGE,
  PERM_DELIVERIES_VIEW,
} from '../../common/constants/permissions';
import { DeliveriesService } from './deliveries.service';
import { CreateRunDto, ListRunsQuery, LoadableInvoicesQuery, PatchRunDto } from './dto/deliveries.dto';

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
  constructor(private readonly deliveries: DeliveriesService) {}

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
  @ApiOkResponse({ description: 'RunDetail' })
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

  @Get('stops/by-invoice/:invoiceNumber')
  @RequirePermissionKeys(PERM_DELIVERIES_VIEW)
  @ApiOperation({ summary: "An invoice's delivery stop, with its run" })
  @ApiOkResponse({ description: 'Stop & { run: { id, runNumber, runDate, status, rep } }' })
  byInvoice(@Param('invoiceNumber') invoiceNumber: string) {
    return this.deliveries.stopByInvoice(invoiceNumber);
  }
}
