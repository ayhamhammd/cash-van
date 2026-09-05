import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SegmentsService } from './segments.service';
import { RepScopeService } from '../users/rep-scope.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { ListSegmentsQuery } from './dto/list-segments.query';
import { ListMembersQuery } from './dto/list-members.query';
import { AddMembersDto } from './dto/add-members.dto';
import { SegmentStatsQuery } from './dto/segment-stats.query';
import { AssignRepDto } from './dto/assign-rep.dto';

@ApiTags('segments')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'segments', version: '1' })
export class SegmentsController {
  constructor(
    private readonly segments: SegmentsService,
    private readonly repScope: RepScopeService,
  ) {}

  @Get()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'List customer segments with member counts' })
  @ApiOkResponse({ description: '{ items, total }' })
  list(@Query() query: ListSegmentsQuery) {
    return this.segments.list(query);
  }

  @Get('by-customer/:customerId')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Segments a customer belongs to (for profile chips)' })
  @ApiOkResponse({ description: 'Segment tags' })
  byCustomer(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.segments.segmentsForCustomer(customerId);
  }

  @Get(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'One segment' })
  @ApiOkResponse({ description: 'Segment' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.segments.getOne(id);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create a segment' })
  @ApiCreatedResponse({ description: 'Created segment' })
  create(@Body() dto: CreateSegmentDto, @CurrentUser('sub') userId: string) {
    return this.segments.create(dto, userId);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a segment' })
  @ApiOkResponse({ description: 'Updated segment' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSegmentDto) {
    return this.segments.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a segment' })
  @ApiOkResponse({ description: 'Deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.segments.remove(id);
    return { success: true };
  }

  @Post(':id/refresh')
  @Roles('admin')
  @ApiOperation({ summary: 'Re-materialise a dynamic segment from its rules' })
  @ApiOkResponse({ description: '{ matched, total }' })
  refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.segments.refresh(id);
  }

  @Get(':id/stats')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Segment sales performance (rep-scope filtered)' })
  @ApiOkResponse({ description: 'Sales stats over [from, to]' })
  async stats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SegmentStatsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.segments.stats(id, query, await this.repScope.visibleRepIds(user));
  }

  @Get(':id/reps')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Salesmen linked to a segment' })
  @ApiOkResponse({ description: 'Linked reps' })
  listReps(@Param('id', ParseUUIDPipe) id: string) {
    return this.segments.listReps(id);
  }

  @Post(':id/reps')
  @Roles('admin')
  @ApiOperation({ summary: 'Link a salesman to a segment' })
  @ApiCreatedResponse({ description: 'Linked reps' })
  addRep(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRepDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.segments.addRep(id, dto.repId, userId);
  }

  @Delete(':id/reps/:repId')
  @Roles('admin')
  @ApiOperation({ summary: 'Unlink a salesman from a segment' })
  @ApiOkResponse({ description: 'Linked reps' })
  removeRep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('repId', ParseUUIDPipe) repId: string,
  ) {
    return this.segments.removeRep(id, repId);
  }

  @Post(':id/assign-rep')
  @Roles('admin')
  @ApiOperation({
    summary: 'Assign every member of a segment to one salesman (bulk reassign)',
  })
  @ApiOkResponse({ description: '{ assigned }' })
  async assignRep(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRepDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.segments.assignAllToRep(
      id,
      dto.repId,
      await this.repScope.visibleRepIds(user),
    );
  }

  @Get(':id/members')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'List a segment’s members (rep-scope filtered)' })
  @ApiOkResponse({ description: '{ items, total }' })
  async members(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMembersQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.segments.listMembers(id, query, await this.repScope.visibleRepIds(user));
  }

  @Post(':id/members')
  @Roles('admin')
  @ApiOperation({ summary: 'Add customers to a segment' })
  @ApiCreatedResponse({ description: '{ added, total }' })
  addMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMembersDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.segments.addMembers(id, dto, userId);
  }

  @Delete(':id/members/:customerId')
  @Roles('admin')
  @ApiOperation({ summary: 'Remove a customer from a segment' })
  @ApiOkResponse({ description: '{ total }' })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.segments.removeMember(id, customerId);
  }
}
