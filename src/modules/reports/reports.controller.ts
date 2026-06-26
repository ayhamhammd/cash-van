import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ReportsService } from './reports.service';
import {
  ReportsQueryDto,
  ReportsRangeQueryDto,
  TripsQueryDto,
} from './dto/reports-query.dto';
import {
  EndOfDayQueryDto,
  SettleEndOfDayDto,
  SettlementsQueryDto,
} from './dto/end-of-day.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Dashboard overview KPIs',
    description:
      'One aggregated payload for the dashboard home page: sales today vs yesterday, payments, visits, customers/debt, cheques due soon, low stock and active reps.',
  })
  @ApiOkResponse({ description: 'Aggregated dashboard KPIs' })
  dashboard() {
    return this.reports.dashboard();
  }

  @Get('sales-trend')
  @ApiOperation({
    summary: 'Daily sales trend',
    description:
      'Zero-filled daily series of posted SALE/RETURN totals and payments for the last N days (default 30).',
  })
  @ApiOkResponse({ description: 'Daily trend points, oldest first' })
  salesTrend(@Query() q: ReportsRangeQueryDto) {
    return this.reports.salesTrend(q.days ?? 30);
  }

  @Get('top-customers')
  @ApiOperation({
    summary: 'Top customers',
    description: 'Customers ranked by posted SALE net total over the last N days.',
  })
  @ApiOkResponse({ description: 'Ranked customers' })
  topCustomers(@Query() q: ReportsRangeQueryDto) {
    return this.reports.topCustomers(q.days ?? 30, q.limit ?? 10);
  }

  @Get('rep-leaderboard')
  @ApiOperation({
    summary: 'Rep leaderboard',
    description:
      'Reps ranked by posted SALE net total over the last N days, with voucher, customer and visit counts.',
  })
  @ApiOkResponse({ description: 'Ranked reps' })
  repLeaderboard(@Query() q: ReportsRangeQueryDto) {
    return this.reports.repLeaderboard(q.days ?? 30, q.limit ?? 10);
  }

  @Get('rep-trips')
  @ApiOperation({
    summary: 'Salesman trips for a day',
    description:
      'Segments each rep’s GPS pings on the given date into trips (start/end, duration, distance, speed, path). Pass repId to focus one salesman.',
  })
  @ApiOkResponse({ description: 'Trips, newest first' })
  repTrips(@Query() q: TripsQueryDto) {
    return this.reports.repTrips(q.date, q.repId);
  }

  @Get('low-stock')
  @ApiOperation({
    summary: 'Low stock items',
    description:
      'Active items whose total on-hand quantity (across all stores) is at or below their reorder quantity.',
  })
  @ApiOkResponse({ description: 'Low stock items, most depleted first' })
  lowStock(@Query() q: ReportsRangeQueryDto) {
    return this.reports.lowStock(q.limit ?? 25);
  }

  @Get('best-items')
  @ApiOperation({
    summary: 'Best-selling items',
    description: 'Items ranked by quantity sold (posted SALE voucher lines). Paginated.',
  })
  @ApiOkResponse({ description: 'Paginated best-selling items' })
  bestItems(@Query() q: ReportsQueryDto) {
    return this.reports.bestItems(q.offset ?? 0, q.limit ?? 25, q.days);
  }

  @Get('visits')
  @ApiOperation({
    summary: 'Customer visits report',
    description: 'All customer visits (newest first) with customer + rep names. Paginated.',
  })
  @ApiOkResponse({ description: 'Paginated visits' })
  visits(@Query() q: ReportsQueryDto) {
    return this.reports.visits(q.offset ?? 0, q.limit ?? 25);
  }

  // ── End-of-Day cash reconciliation (admin/manager) ──────────────────────────

  @Get('end-of-day')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'End-of-Day report',
    description:
      "Per-salesman cash/cheque collections, cash/credit sales, cash returns, discount, expected cash, and the salesman's carried balance, over a date range.",
  })
  @ApiOkResponse({ description: '{ from, to, rows, totals } — money in fils' })
  endOfDay(@Query() q: EndOfDayQueryDto) {
    return this.reports.endOfDay(q.from, q.to, q.repId);
  }

  @Post('end-of-day/settle')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Settle a salesman End-of-Day',
    description:
      'Records the cash received from a salesman for a period; carries the difference (expected − received) onto their running balance. Recomputes the period server-side.',
  })
  @ApiCreatedResponse({ description: 'The created settlement (with newBalanceFils)' })
  settle(@Body() dto: SettleEndOfDayDto, @CurrentUser('sub') userId: string) {
    return this.reports.settle(dto, userId);
  }

  @Get('end-of-day/settlements')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Settlement history', description: 'Past End-of-Day settlements (newest first).' })
  @ApiOkResponse({ description: 'SalesmanSettlement[]' })
  settlements(@Query() q: SettlementsQueryDto) {
    return this.reports.listSettlements(q);
  }
}
