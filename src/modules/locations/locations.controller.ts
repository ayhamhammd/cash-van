import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissionKeys } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CreateLocationDto,
  DryRunQuery,
  ImportFlatAreasDto,
  ListLocationMembersQuery,
  ListLocationsQuery,
  LocationMembersDto,
  ReorderLocationsDto,
  SetLocationRepDto,
  SwitchLocationModeDto,
  UpdateLocationDto,
} from './dto/location.dto';
import { LocationTreeService } from './locations.service';

/**
 * The location tree (country › governorate › area). Guarded by the same keys
 * as the flat areas — `areas.view` opens the screen, `areas.edit` allows every
 * write — so a role that manages areas today manages the tree. Switching the
 * company between the two is admin-only. The rep's picker is not here: it is
 * GET /customers/locations, open to any signed-in user.
 */
@ApiTags('locations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'locations', version: '1' })
export class LocationTreeController {
  constructor(private readonly locations: LocationTreeService) {}

  @Get()
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'Every node of the tree, flat, with customer counts' })
  @ApiOkResponse({ description: '{ items, total } — the client nests them by parentId' })
  list(@Query() q: ListLocationsQuery) {
    return this.locations.list(q.includeInactive ?? true);
  }

  @Post('mode')
  @Roles('admin')
  @ApiOperation({ summary: 'Switch the company between flat areas (FLAT) and the tree (TREE)' })
  switchMode(@Body() dto: SwitchLocationModeDto) {
    return this.locations.switchMode(dto.mode, dto.dryRun ?? false);
  }

  @Post('seed-jordan')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: "Add Jordan and its 12 governorates (skips what exists)" })
  seedJordan() {
    return this.locations.seedJordan();
  }

  @Post('import-flat')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Bring flat areas into the tree under the chosen governorates' })
  importFlat(@Body() dto: ImportFlatAreasDto) {
    return this.locations.importFlat(dto);
  }

  @Post('reorder')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Set the order of the places under one parent' })
  reorder(@Body() dto: ReorderLocationsDto) {
    return this.locations.reorder(dto.parentId ?? null, dto.ids);
  }

  @Get('covered-by/:repId')
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'The places a salesman covers, with their customer counts' })
  coveredBy(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.locations.coveredBy(repId);
  }

  @Get(':id')
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'One node, with the nodes above it' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.locations.getWithAncestors(id);
  }

  @Post()
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Add a country, a governorate under it, or an area under a governorate' })
  create(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch(':id')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Rename, recode, recolour, (de)activate, or move an area to another governorate' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Delete a place with nothing under it and no customers' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.locations.remove(id);
    return { success: true };
  }

  /**
   * Who covers this place. Moving customers between salesmen is its own
   * permission (customers.assignSalesman) on top of editing places.
   */
  @Put(':id/rep')
  @RequirePermissionKeys('areas.edit', 'customers.assignSalesman')
  @ApiOperation({
    summary: 'Give a place a salesman (or take him away); its customers without one of their own follow',
  })
  setRep(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetLocationRepDto,
    @Query() q: DryRunQuery,
  ) {
    return this.locations.setRep(id, dto.repId ?? null, q.dryRun ?? false);
  }

  @Get(':id/members')
  @RequirePermissionKeys('areas.view')
  @ApiOperation({ summary: 'Customers in an area, or under a governorate with subtree=true' })
  members(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListLocationMembersQuery) {
    return this.locations.members(id, q);
  }

  @Post(':id/members')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Place customers in an area' })
  addMembers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LocationMembersDto) {
    return this.locations.addMembers(id, dto.customerIds);
  }

  @Delete(':id/members/:customerId')
  @RequirePermissionKeys('areas.edit')
  @ApiOperation({ summary: 'Take a customer out of an area' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    await this.locations.removeMember(id, customerId);
    return { success: true };
  }
}
