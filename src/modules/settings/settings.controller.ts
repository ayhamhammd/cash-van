import {
  Body,
  Controller,
  FileTypeValidator,
  Get,
  MaxFileSizeValidator,
  ParseFilePipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import { UpdateAppSettingsDto } from './dto/update-settings.dto';
import { UpdateJoFotaraDto } from './dto/update-jofotara.dto';
import { UpdateErpDto } from './dto/update-erp.dto';
import { UpdateAiDto } from './dto/update-ai.dto';
import { UpdateHubDto } from './dto/update-hub.dto';
import { SetTobaccoTaxDto } from './dto/set-tobacco-tax.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';

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
  @UseGuards(ErpReadOnlyGuard)
  @ApiOperation({
    summary: 'Update app settings',
    description:
      'Update non-secret company settings (names, seller TIN/address, locale, AI quotas). Admin only.',
  })
  @ApiOkResponse({ description: 'Updated app settings' })
  update(@Body() dto: UpdateAppSettingsDto) {
    return this.settings.update(dto);
  }

  @Post('logo')
  @UseGuards(ErpReadOnlyGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload company logo',
    description:
      'Upload a company logo image (PNG/JPEG/WebP/SVG, max 2 MB). Stored inline on the settings row and returned as `logoUrl`. Admin only.',
  })
  @ApiOkResponse({ description: 'Updated app settings with the new logo' })
  uploadLogo(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 2 * 1024 * 1024 }),
          new FileTypeValidator({
            fileType: /^image\/(png|jpe?g|webp|gif|svg\+xml)$/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.settings.setLogo(file);
  }

  @Patch('tobacco-tax')
  @ApiOperation({
    summary: 'Toggle the tobacco tax feature',
    description:
      'Enable/disable local tobacco ("smoke") tax. A FlowVan feature flag — NOT ERP-managed, so it works even when the ERP integration is on. Admin only.',
  })
  @ApiOkResponse({ description: '{ tobaccoTaxEnabled }' })
  setTobaccoTax(@Body() dto: SetTobaccoTaxDto) {
    return this.settings.setTobaccoTaxEnabled(dto.enabled);
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

  @Patch('erp')
  @ApiOperation({
    summary: 'Configure the ERP connection + toggle',
    description:
      'Enable/disable working with the ERP and set its base URL + API key (encrypted). Omit apiKey to keep the current one. Admin only.',
  })
  @ApiOkResponse({ description: 'ERP settings (key masked)' })
  updateErp(@Body() dto: UpdateErpDto) {
    return this.settings.updateErp(dto);
  }

  @Post('erp/test')
  @ApiOperation({
    summary: 'Test the ERP connection',
    description: 'Probes the configured ERP (health + a 1-row catalog read) with the stored key. Admin only.',
  })
  @ApiOkResponse({ description: '{ ok, message }' })
  testErp() {
    return this.settings.testErp();
  }

  @Patch('ai')
  @ApiOperation({
    summary: 'Configure the AI assistant provider + key',
    description:
      'Pick the LLM provider (anthropic | openai | gemini) and set its API key (encrypted). Omit apiKey to keep the current one. Admin only.',
  })
  @ApiOkResponse({ description: 'AI settings (key masked)' })
  updateAi(@Body() dto: UpdateAiDto) {
    return this.settings.updateAi(dto);
  }

  @Patch('hub')
  @ApiOperation({
    summary: 'Configure the ERP Integration Hub connection',
    description:
      'Set the Hub base URL, sync + webhook secrets (encrypted), and the enabled toggle. Partner id is optional — the Hub identifies the partner from the sync token. Omit a secret to keep the current one. Admin only.',
  })
  @ApiOkResponse({ description: 'Hub settings (secrets masked)' })
  updateHub(@Body() dto: UpdateHubDto) {
    return this.settings.updateHub(dto);
  }

  @Post('hub/test')
  @ApiOperation({
    summary: 'Test the Integration Hub connection',
    description: 'Probes GET {hubBaseUrl}/api/health with the stored config. Admin only.',
  })
  @ApiOkResponse({ description: '{ ok, message }' })
  testHub() {
    return this.settings.testHub();
  }

  @Post('hub/verify')
  @ApiOperation({
    summary: 'Verify the Hub recognizes this Van Sales client',
    description:
      "Calls GET {hubBaseUrl}/api/client/profile with the stored sync token. Confirms the token is accepted and returns the partner's public profile (no secrets). Admin only.",
  })
  @ApiOkResponse({ description: '{ ok, message, profile? }' })
  verifyHub() {
    return this.settings.verifyHubClient();
  }
}
