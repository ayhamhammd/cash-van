import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { TobaccoTaxProfilesService } from './tobacco-tax-profiles.service';
import {
  CreateTobaccoTaxProfileDto,
  UpdateTobaccoTaxProfileDto,
} from './dto/tobacco-tax-profile.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';

/**
 * Tobacco tax profiles API. GET is reachable by any authenticated user (the app
 * + dashboard read the profiles). Writes are admin-only and blocked while the
 * ERP integration is ON (ErpReadOnlyGuard) — then profiles are ERP-managed.
 */
@ApiTags('tobacco-tax-profiles')
@ApiBearerAuth()
@Controller({ path: 'tobacco-tax-profiles', version: '1' })
export class TobaccoTaxProfilesController {
  constructor(private readonly service: TobaccoTaxProfilesService) {}

  @Get()
  @ApiOperation({
    summary: 'List tobacco tax profiles',
    description: 'Active profiles by default; pass ?all=true to include deactivated. Any authenticated user.',
  })
  @ApiOkResponse({ description: 'Tobacco tax profiles' })
  list(@Query('all') all?: string) {
    return this.service.list(all !== 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a tobacco tax profile' })
  @ApiOkResponse({ description: 'Tobacco tax profile' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  @UseGuards(RolesGuard, ErpReadOnlyGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Create a tobacco tax profile',
    description: 'Standalone mode only — blocked while the ERP integration is ON. Admin only.',
  })
  @ApiOkResponse({ description: 'Created profile' })
  create(@Body() dto: CreateTobaccoTaxProfileDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard, ErpReadOnlyGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Update a tobacco tax profile', description: 'Standalone mode only. Admin only.' })
  @ApiOkResponse({ description: 'Updated profile' })
  update(@Param('id') id: string, @Body() dto: UpdateTobaccoTaxProfileDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard, ErpReadOnlyGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Deactivate a tobacco tax profile', description: 'Standalone mode only. Admin only.' })
  @ApiOkResponse({ description: 'Deactivated profile' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
