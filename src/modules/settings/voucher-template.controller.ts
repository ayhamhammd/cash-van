import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import { VoucherTemplateDto } from './dto/voucher-template.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * Voucher (receipt) print template for the FlowVan app + admin editor.
 *
 * - `GET` is reachable by ANY authenticated user (the global JwtAuthGuard still
 *   applies) — the mobile app fetches it once per session to render receipts.
 * - `PUT` is admin-only and upserts the company's override delta; it returns the
 *   resolved template. A `PUT {}` resets to the Jordan base template.
 */
@ApiTags('voucher-template')
@ApiBearerAuth()
@Controller({ path: 'voucher-template', version: '1' })
export class VoucherTemplateController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get resolved voucher template',
    description:
      'Base template merged with this company\'s overrides (complete object — no client-side merge). Any authenticated user.',
  })
  @ApiOkResponse({ description: 'Resolved voucher template' })
  get() {
    return this.settings.getVoucherTemplate();
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Update voucher template',
    description:
      'Upsert the voucher template (full or partial). The server stores only the delta from base and returns the resolved template. PUT {} resets to base. Admin only.',
  })
  @ApiOkResponse({ description: 'Resolved voucher template after save' })
  upsert(@Body() dto: VoucherTemplateDto) {
    return this.settings.upsertVoucherTemplate(dto);
  }
}
