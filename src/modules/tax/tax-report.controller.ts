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
import { LedgerEntryType } from './entities/tax-ledger-entry.entity';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { filsToJod } from '../../common/utils/currency.util';

@ApiTags('tax')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin', 'manager')
@Controller({ path: 'tax', version: '1' })
export class TaxReportController {
  constructor(private readonly ledger: TaxLedgerService) {}

  @Get('report')
  @ApiOperation({
    summary: 'Monthly tax report',
    description:
      'Monthly net-output-tax report computed from VALIDATED ledger entries (sales tax − returns tax).',
  })
  @ApiQuery({ name: 'year', required: true, description: 'Year', example: 2026 })
  @ApiQuery({ name: 'month', required: true, description: 'Month (1-12)', example: 5 })
  @ApiOkResponse({ description: 'Monthly totals (sales, returns, net output tax, counts)' })
  report(@Query('year') year: string, @Query('month') month: string) {
    return this.ledger.monthlyReport(Number(year), Number(month));
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
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('entryType') entryType?: LedgerEntryType,
  ) {
    return this.ledger.list(from, to, entryType);
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
    @Query('year') year: string,
    @Query('month') month: string,
  ) {
    const r = await this.ledger.monthlyReport(Number(year), Number(month));
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
