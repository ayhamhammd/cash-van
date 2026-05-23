import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import { UpdateAppSettingsDto } from './dto/update-settings.dto';
import { UpdateJoFotaraDto } from './dto/update-jofotara.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin')
@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get app settings',
    description:
      'Returns the single-row company/app settings. The JoFotara secret key is masked. Admin only.',
  })
  @ApiOkResponse({ description: 'Current app settings (secret masked)' })
  get() {
    return this.settings.get();
  }

  @Patch()
  @ApiOperation({
    summary: 'Update app settings',
    description:
      'Update non-secret company settings (names, seller TIN/address, locale, AI quotas). Admin only.',
  })
  @ApiOkResponse({ description: 'Updated app settings' })
  update(@Body() dto: UpdateAppSettingsDto) {
    return this.settings.update(dto);
  }

  @Patch('jofotara')
  @ApiOperation({
    summary: 'Set JoFotara credentials',
    description:
      'Set or rotate the ISTD JoFotara API credentials. The secret is encrypted before storage. Admin only.',
  })
  @ApiOkResponse({ description: 'Credentials stored (secret encrypted + masked)' })
  updateJoFotara(@Body() dto: UpdateJoFotaraDto) {
    return this.settings.updateJoFotara(dto);
  }
}
