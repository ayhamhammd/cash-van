import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import { VoucherReportDto } from './dto/voucher-report.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * Banded voucher report ("FR3 for vouchers") for the FlowVan app + drag-and-drop
 * designer.
 *
 * - `GET` is reachable by ANY authenticated user — the mobile app renders
 *   receipts from the resolved layout.
 * - `PUT` (admin) upserts the whole validated document; `DELETE` resets it to
 *   the Jordan default layout.
 */
@ApiTags('voucher-report')
@ApiBearerAuth()
@Controller({ path: 'voucher-report', version: '1' })
export class VoucherReportController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get resolved voucher report layout',
    description: 'The company\'s banded voucher layout, or the Jordan default when unset. Any authenticated user.',
  })
  @ApiOkResponse({ description: 'Resolved voucher report' })
  get() {
    return this.settings.getVoucherReport();
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Save voucher report layout',
    description: 'Upsert the whole banded voucher document (validated). Admin only.',
  })
  @ApiOkResponse({ description: 'Saved voucher report' })
  upsert(@Body() dto: VoucherReportDto) {
    return this.settings.upsertVoucherReport(dto);
  }

  @Delete()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Reset voucher report to default',
    description: 'Clears the custom layout so the company inherits the Jordan default. Admin only.',
  })
  @ApiOkResponse({ description: 'Default voucher report' })
  reset() {
    return this.settings.resetVoucherReport();
  }
}
