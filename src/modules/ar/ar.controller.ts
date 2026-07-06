import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { ArService, type AgingBasis } from './ar.service';

function parseBasis(v?: string): AgingBasis {
  return v === 'invoice' ? 'invoice' : 'due';
}
function parseIntOr(v: string | undefined, def: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Accounts receivable (debt / ذمم) read API. Balance + aging are proxied from the ERP
 * (source of truth); the arrears widget is computed locally. See
 * docs/SPEC-accounts-receivable.md.
 */
@ApiTags('accounts-receivable')
@Controller({ path: 'ar', version: '1' })
export class ArController {
  constructor(private readonly ar: ArService) {}

  /** Org-wide aging roll-up (one row per customer with an open balance). */
  @Get('aging')
  @ApiOkResponse({ description: 'Per-customer aging rows + org summary' })
  orgAging(
    @Query('basis') basis?: string,
    @Query('asOf') asOf?: string,
    @Query('warehouseCode') warehouseCode?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.ar.orgAging({
      basis: parseBasis(basis),
      asOf,
      warehouseCode,
      page: parseIntOr(page, 1),
      pageSize: Math.min(200, parseIntOr(pageSize, 50)),
    });
  }

  /** Arrears + monthly-collection widget (month = YYYY-MM, default current). */
  @Get('arrears-summary')
  @ApiOkResponse({ description: 'Monthly credit-sold vs collected + arrears list' })
  arrearsSummary(@Query('month') month?: string) {
    return this.ar.arrearsSummary(month);
  }

  /** Single-customer aging (due/invoice basis). */
  @Get('customers/:customerNumber/aging')
  @ApiOkResponse({ description: 'Customer aging buckets + open invoices' })
  customerAging(
    @Param('customerNumber') customerNumber: string,
    @Query('basis') basis?: string,
    @Query('asOf') asOf?: string,
  ) {
    return this.ar.customerAging(customerNumber, parseBasis(basis), asOf);
  }

  /** Single-customer live balance + available credit. */
  @Get('customers/:customerNumber/balance')
  @ApiOkResponse({ description: 'Balance, credit limit, available credit' })
  customerBalance(@Param('customerNumber') customerNumber: string) {
    return this.ar.customerBalance(customerNumber);
  }
}
