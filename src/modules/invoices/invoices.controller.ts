import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { ListInvoicesQuery } from './dto/list-invoices.query';
import { RejectInvoiceDto, OverrideInvoiceDto } from './dto/approval-action.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('invoices')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'invoices', version: '1' })
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List invoices',
    description: 'List invoices with filters (status, rep, customer, date range) and paging.',
  })
  @ApiOkResponse({ description: 'Paginated invoice list' })
  list(@Query() query: ListInvoicesQuery) {
    return this.invoices.list(query);
  }

  @Get('export')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Export invoices to XLSX',
    description:
      'Export invoices and their line items to an XLSX workbook for a date range. Admin/manager only.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Start date (YYYY-MM-DD)', example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, description: 'End date (YYYY-MM-DD)', example: '2026-05-31' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'XLSX file download (binary)' })
  async export(
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const buf = await this.invoices.exportXlsx(from, to);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="invoices.xlsx"',
    });
    res.send(buf);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get invoice', description: 'Fetch a single invoice with its lines.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiOkResponse({ description: 'The invoice with lines' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.findOne(id);
  }

  @Get(':id/audit')
  @ApiOperation({
    summary: 'Invoice audit timeline',
    description: 'Approval / audit timeline for an invoice.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiOkResponse({ description: 'Ordered approval/audit events' })
  audit(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.audit(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create invoice',
    description: 'Create a draft invoice. Computes per-line and invoice-level tax.',
  })
  @ApiCreatedResponse({ description: 'Draft invoice created with computed totals' })
  create(@Body() dto: CreateInvoiceDto) {
    return this.invoices.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit draft invoice',
    description: 'Edit a draft invoice. Recomputes tax. Only drafts are editable.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiOkResponse({ description: 'Updated draft invoice' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoices.update(id, dto);
  }

  @Post(':id/confirm')
  @ApiOperation({
    summary: 'Confirm invoice',
    description:
      'Confirm a draft invoice. Emits invoice.confirmed (triggers anomaly + JoFotara submission hooks).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiCreatedResponse({ description: 'Confirmed invoice' })
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.confirm(id);
  }

  @Post(':id/cancel')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Cancel invoice', description: 'Cancel an invoice. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiCreatedResponse({ description: 'Cancelled invoice' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.cancel(id);
  }

  @Post(':id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Approve invoice',
    description: 'Manager approves a confirmed/pending invoice. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: { reason: { type: 'string', example: 'Within credit limit' } },
    },
  })
  @ApiCreatedResponse({ description: 'Approved invoice' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: string }) {
    return this.invoices.approve(id, body?.reason);
  }

  @Post(':id/reject')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Reject invoice',
    description: 'Manager rejects an invoice, returning it to draft with a reason. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiCreatedResponse({ description: 'Invoice returned to draft' })
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectInvoiceDto) {
    return this.invoices.reject(id, dto);
  }

  @Post(':id/override')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Override invoice discount',
    description:
      'Manager overrides the invoice-level discount. Recomputes totals; the change is audited. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiCreatedResponse({ description: 'Invoice with overridden discount + recomputed totals' })
  override(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OverrideInvoiceDto) {
    return this.invoices.override(id, dto);
  }
}
