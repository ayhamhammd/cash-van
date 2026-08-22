import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { VoucherSummaryQuery } from './dto/voucher-summary.query';
import { ReportsService } from './reports.service';
import {
  ReportsQueryDto,
  ReportsRangeQueryDto,
  TripsQueryDto,
} from './dto/reports-query.dto';
import {
  EndOfDayQueryDto,
  EodLockQueryDto,
  SettleEndOfDayDto,
  SettlementsQueryDto,
} from './dto/end-of-day.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RepCommissionQueryDto } from './dto/rep-commission.query';
import { RepScopeService } from '../users/rep-scope.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly repScope: RepScopeService,
  ) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Dashboard overview KPIs',
    description:
      'One aggregated payload for the dashboard home page: sales today vs yesterday, payments, visits, customers/debt, cheques due soon, low stock and active reps.',
  })
  @ApiOkResponse({ description: 'Aggregated dashboard KPIs' })
  async dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.reports.dashboard(await this.repScope.visibleRepIds(user));
  }

  @Get('sales-trend')
  @ApiOperation({
    summary: 'Daily sales trend',
    description:
      'Zero-filled daily series of posted SALE/RETURN totals and payments for the last N days (default 30).',
  })
  @ApiOkResponse({ description: 'Daily trend points, oldest first' })
  async salesTrend(@Query() q: ReportsRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.salesTrend(q.days ?? 30, await this.repScope.visibleRepIds(user));
  }

  @Get('top-customers')
  @ApiOperation({
    summary: 'Top customers',
    description: 'Customers ranked by posted SALE net total over the last N days.',
  })
  @ApiOkResponse({ description: 'Ranked customers' })
  async topCustomers(@Query() q: ReportsRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.topCustomers(q.days ?? 30, q.limit ?? 10, await this.repScope.visibleRepIds(user));
  }

  @Get('rep-leaderboard')
  @ApiOperation({
    summary: 'Rep leaderboard',
    description:
      'Reps ranked by posted SALE net total over the last N days, with voucher, customer and visit counts.',
  })
  @ApiOkResponse({ description: 'Ranked reps' })
  async repLeaderboard(@Query() q: ReportsRangeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.repLeaderboard(q.days ?? 30, q.limit ?? 10, await this.repScope.visibleRepIds(user));
  }

  @Get('rep-commission')
  @ApiOperation({
    summary: 'One salesman\'s commission for a date range',
    description:
      "Gross sales, returns, the net of the two, and the commission due at the " +
      "rep's saved rate. Net-of-returns is the base — no commission on returned " +
      "goods. Rep-scoped: an out-of-scope rep returns a zeroed sheet.",
  })
  @ApiOkResponse({ description: 'Commission breakdown for the rep + range' })
  async repCommission(
    @Query() q: RepCommissionQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reports.repCommission(
      q.repId,
      q.from,
      q.to,
      await this.repScope.visibleRepIds(user),
    );
  }

  @Get('rep-trips')
  @ApiOperation({
    summary: 'Salesman trips for a day',
    description:
      'Segments each rep’s GPS pings on the given date into trips (start/end, duration, distance, speed, path). Pass repId to focus one salesman.',
  })
  @ApiOkResponse({ description: 'Trips, newest first' })
  async repTrips(@Query() q: TripsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.repTrips(q.date, q.repId, await this.repScope.visibleRepIds(user));
  }


  @Get('voucher-summary')
  @ApiOperation({
    summary: 'Voucher summary with footer totals',
    description:
      'Posted vouchers in a date range, optionally narrowed to one salesman, one voucher kind (SALE/RETURN/ORDER) and cash-vs-credit. Returns the rows, the footer totals (sub-total, tax, discount, net) aggregated over the WHOLE range, and the collections taken in the same window split by method.',
  })
  @ApiOkResponse({ description: 'Rows, totals and collections' })
  async voucherSummary(@Query() query: VoucherSummaryQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.voucherSummary(query, await this.repScope.visibleRepIds(user));
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
  async bestItems(@Query() q: ReportsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.bestItems(q.offset ?? 0, q.limit ?? 25, q.days, await this.repScope.visibleRepIds(user));
  }

@Get('new-customers')
  @ApiOperation({
    summary: 'New customers by source',
    description:
      'Customers created in a date window, grouped by how they came in — the ' +
      "headline being how many arrived through Find Customers (source='PROSPECTING') " +
      'rather than being typed in. Also broken down per salesman. Rep-scoped.',
  })
  @ApiQuery({ name: 'from', description: 'YYYY-MM-DD, inclusive', example: '2026-08-01' })
  @ApiQuery({ name: 'to', description: 'YYYY-MM-DD, inclusive', example: '2026-08-31' })
  @ApiOkResponse({ description: 'Totals by source, plus a per-rep breakdown' })
  async newCustomers(
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reports.newCustomers(from, to, await this.repScope.visibleRepIds(user));
  }

    @Get('visits')
  @ApiOperation({
    summary: 'Customer visits report',
    description: 'All customer visits (newest first) with customer + rep names. Paginated.',
  })
  @ApiOkResponse({ description: 'Paginated visits' })
  async visits(@Query() q: ReportsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.visits(q.offset ?? 0, q.limit ?? 25, await this.repScope.visibleRepIds(user));
  }

  @Get('visits-no-transaction')
  @ApiOperation({
    summary: "Today's no-transaction visits",
    description: 'Customers visited today where the rep did no business (had_sale=false), with customer + rep names.',
  })
  @ApiOkResponse({ description: 'Today no-transaction visits' })
  async noTransactionVisits(@CurrentUser() user: AuthenticatedUser) {
    return this.reports.noTransactionVisitsToday(await this.repScope.visibleRepIds(user));
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
  async endOfDay(@Query() q: EndOfDayQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.endOfDay(
      q.from,
      q.to,
      q.repId,
      await this.repScope.visibleRepIds(user),
    );
  }

  @Post('end-of-day/settle')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Settle a salesman End-of-Day',
    description:
      'Records the cash received from a salesman for a period; carries the difference (expected − received) onto their running balance. Recomputes the period server-side.',
  })
  @ApiCreatedResponse({ description: 'The created settlement (with newBalanceFils)' })
  async settle(
    @Body() dto: SettleEndOfDayDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Settling WRITES a balance against a salesman. Filtering it away would read
    // as "nothing to settle"; a 403 says whose it is.
    await this.repScope.assertCanSeeRep(user, dto.repId);
    return this.reports.settle(dto, userId);
  }

  @Get('end-of-day/settlements')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Settlement history', description: 'Past End-of-Day settlements with rep name (newest first).' })
  @ApiOkResponse({ description: 'SettlementRow[]' })
  async settlements(
    @Query() q: SettlementsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reports.listSettlements(q, await this.repScope.visibleRepIds(user));
  }

  /**
   * EOD lock check — called by the mobile app before creating any transaction.
   * If locked=true the salesman may not post vouchers, returns, or collections
   * for the locked date until the admin unlocks or a new day begins.
   * Accessible to any authenticated user (salesman JWT included).
   */
  @Get('eod-lock/:repId')
  @ApiOperation({
    summary: 'Check EOD lock for a salesman',
    description:
      'Returns locked=true when the salesman has a settled End-of-Day covering the given date (defaults to today). The mobile app calls this before allowing new transactions.',
  })
  @ApiOkResponse({ description: '{ locked, lockedSince?, periodFrom?, periodTo?, settlementId? }' })
  async eodLock(
    @Param('repId') repId: string,
    @Query() q: EodLockQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // A salesman's own scope is [their own repId], so the mobile app's call for
    // itself passes unchanged; only a scoped supervisor asking about someone
    // else's van is refused.
    await this.repScope.assertCanSeeRep(user, repId);
    return this.reports.getEodLock(repId, q.date);
  }
}
