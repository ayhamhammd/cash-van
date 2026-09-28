import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissionKeys } from '../../common/decorators/permissions.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AreasService } from './areas.service';
import { AreaMembersDto, CreateAreaDto, ListAreaMembersQuery, UpdateAreaDto } from './dto/area.dto';

/**
 * Customer areas. `areas.view` opens the screen and `areas.edit` allows every
 * write; admins pass both, as with segments. The rep's picker is not here: it
 * is GET /customers/areas, open to any signed-in user.
 */
@ApiTags('areas')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'areas', version: '1' })
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  @Get()
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'List areas with their customer counts' })
  @ApiOkResponse({ description: '{ items, total }' })
  list() {
    return this.areas.list();
  }

  @Get(':id')
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'One area' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.areas.getOne(id);
  }

  @Post()
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Create an area' })
  create(@Body() dto: CreateAreaDto) {
    return this.areas.create(dto);
  }

  @Patch(':id')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Rename, recolour, activate or deactivate an area' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAreaDto) {
    return this.areas.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Delete an area; its customers are left with none' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.areas.remove(id);
    return { success: true };
  }

  @Get(':id/members')
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'Customers in an area' })
  members(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListAreaMembersQuery) {
    return this.areas.members(id, q);
  }

  @Post(':id/members')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Move customers into an area' })
  addMembers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AreaMembersDto) {
    return this.areas.addMembers(id, dto.customerIds);
  }

  @Delete(':id/members/:customerId')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Take a customer out of an area' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    await this.areas.removeMember(id, customerId);
    return { success: true };
  }
}
