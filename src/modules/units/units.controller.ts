import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { UnitsService } from './units.service';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';

@ApiTags('units')
@ApiBearerAuth()
@UseGuards(RolesGuard, ErpReadOnlyGuard)
@Controller({ path: 'units', version: '1' })
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  @ApiOperation({ summary: 'List units', description: 'Global unit catalog ordered by code.' })
  @ApiOkResponse({ description: 'Units' })
  list() {
    return this.units.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get unit', description: 'Fetch a single unit by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Unit id' })
  @ApiOkResponse({ description: 'The unit' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.units.findOne(id);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create unit', description: 'Add a unit to the catalog. Admin/manager only.' })
  @ApiCreatedResponse({ description: 'Unit created' })
  create(@Body() dto: CreateUnitDto) {
    return this.units.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Update unit', description: 'Update a unit. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Unit id' })
  @ApiOkResponse({ description: 'Updated unit' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUnitDto) {
    return this.units.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete unit',
    description: 'Delete a unit. Blocked (409) while any item_units row references it.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Unit id' })
  @ApiNoContentResponse({ description: 'Unit deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.units.remove(id);
  }
}
