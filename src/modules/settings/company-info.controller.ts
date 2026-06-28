import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service';

/**
 * Company profile for the FlowVan app. Unlike `GET /settings` (admin-only, leaks
 * ERP/JoFotara/AI config), this is reachable by ANY authenticated user (the
 * global JwtAuthGuard still applies) and returns only safe company fields +
 * taxCalcMethod, so the app's offline money engine matches the dashboard.
 */
@ApiTags('company-info')
@ApiBearerAuth()
@Controller({ path: 'company-info', version: '1' })
export class CompanyInfoController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Company info',
    description: 'Company profile + tax mode for the app. Any authenticated user.',
  })
  @ApiOkResponse({ description: 'Company info' })
  get() {
    return this.settings.getCompanyInfo();
  }
}
