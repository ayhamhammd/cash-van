import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import * as ExcelJS from 'exceljs';

import { TaxLedgerService } from './tax-ledger.service';
import {
  JoFotaraExportService,
  type JoFotaraState,
} from './jofotara-export.service';
import { LedgerEntryType } from './entities/tax-ledger-entry.entity';
import { RepScopeService } from '../users/rep-scope.service';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { filsToJod } from '../../common/utils/currency.util';

@ApiTags('tax')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin', 'manager')
@Controller({ path: 'tax', version: '1' })
export class TaxReportController {
  constructor(
    private readonly ledger: TaxLedgerService,
    private readonly repScope: RepScopeService,
    private readonly jofotaraExport: JoFotaraExportService,
  ) {}

  @Get('report')
  @ApiOperation({
    summary: 'Monthly tax report',
    description:
      'Monthly net-output-tax report computed from VALIDATED ledger entries (sales tax − returns tax).',
  })
  @ApiQuery({ name: 'year', required: true, description: 'Year', example: 2026 })
  @ApiQuery({ name: 'month', required: true, description: 'Month (1-12)', example: 5 })
  @ApiOkResponse({ description: 'Monthly totals (sales, returns, net output tax, counts)' })
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('month') month: string,
  ) {
    return this.ledger.monthlyReport(
      Number(year),
      Number(month),
      await this.repScope.visibleRepIds(user),
    );
  }

  @Get('ledger')
  @ApiOperation({
    summary: 'List ledger entries',
    description: 'List tax ledger entries, filterable by date range and entry type.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Start date (YYYY-MM-DD)', example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, description: 'End date (YYYY-MM-DD)', example: '2026-05-31' })
  @ApiQuery({ name: 'entryType', required: false, enum: ['SALE', 'RETURN'], description: 'Filter by entry type' })
  @ApiOkResponse({ description: 'Tax ledger entries' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('entryType') entryType?: LedgerEntryType,
  ) {
    return this.ledger.list(from, to, entryType, await this.repScope.visibleRepIds(user));
  }

  @Get('jofotara/summary')
  @ApiOperation({
    summary: 'JoFotara export status — counts',
    description:
      'How many POSTED SALES in the period reached the government and how many did ' +
      'not: exported (the QR came back), failed (REJECTED/ERROR — terminal, it will ' +
      'never gain a QR by waiting) and pending (everything else, including a sale ' +
      'that was never submitted). Only sales are filed, so transfers and van loads ' +
      'are excluded rather than counted as unexported.',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-05-31' })
  @ApiOkResponse({ description: '{ total, exported, pending, failed }' })
  async jofotaraSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const codes = await this.jofotaraExport.userCodesForReps(
      await this.repScope.visibleRepIds(user),
    );
    return this.jofotaraExport.summary(from, to, codes);
  }

  @Get('jofotara/vouchers')
  @ApiOperation({
    summary: 'JoFotara export status — the vouchers',
    description:
      'The posted sales behind the summary, newest first, with the salesman and ' +
      'customer on each. Filter with `state` to get exactly the list the office ' +
      'needs: PENDING and FAILED are the ones that did NOT reach the authority.',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-05-31' })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ['EXPORTED', 'PENDING', 'FAILED'],
    description: 'Omit for all three',
  })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ description: '{ items, total }' })
  async jofotaraVouchers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('state') state?: JoFotaraState,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const codes = await this.jofotaraExport.userCodesForReps(
      await this.repScope.visibleRepIds(user),
    );
    return this.jofotaraExport.list(
      from,
      to,
      state,
      codes,
      Math.min(Number(limit) || 100, 500),
      Number(offset) || 0,
    );
  }

  @Get('report/export')
  @ApiOperation({
    summary: 'Export monthly report (XLSX)',
    description: 'Monthly tax report as an XLSX workbook for ISTD filing.',
  })
  @ApiQuery({ name: 'year', required: true, description: 'Year', example: 2026 })
  @ApiQuery({ name: 'month', required: true, description: 'Month (1-12)', example: 5 })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'XLSX file download (binary)' })
  async export(
    @Res() res: Response,
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year: string,
    @Query('month') month: string,
  ) {
    // Scoped like the on-screen report, or the download becomes the way round it.
    const r = await this.ledger.monthlyReport(
      Number(year),
      Number(month),
      await this.repScope.visibleRepIds(user),
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tax Report');
    ws.addRow(['Period', `${r.periodFrom} → ${r.periodTo}`]);
    ws.addRow(['Total Sales (JOD)', filsToJod(r.totalSalesFils)]);
    ws.addRow(['Sales Tax (JOD)', filsToJod(r.totalSalesTaxFils)]);
    ws.addRow(['Total Returns (JOD)', filsToJod(r.totalReturnsFils)]);
    ws.addRow(['Returns Tax (JOD)', filsToJod(r.totalReturnsTaxFils)]);
    ws.addRow(['Net Output Tax (JOD)', filsToJod(r.netOutputTaxFils)]);
    ws.addRow(['Invoices', r.invoiceCount]);
    ws.addRow(['Credit Notes', r.creditNoteCount]);
    const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="tax-report-${year}-${month}.xlsx"`,
    });
    res.send(buf);
  }
}
