import {
  Body,
  Controller,
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
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RoutesService } from './routes.service';
import { CreateRoutePlanDto } from './dto/create-route-plan.dto';
import {
  GenerateRoutesDto,
  MarkSkippedDto,
  MarkVisitedDto,
  ReorderStopsDto,
} from './dto/route-actions.dto';
import { ListRoutesQuery } from './dto/list-routes.query';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('routes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'routes', version: '1' })
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  @ApiOperation({
    summary: 'List route plans',
    description: 'List route plans, optionally filtered by date and/or rep.',
  })
  @ApiOkResponse({ description: 'Route plan list' })
  list(@Query() query: ListRoutesQuery) {
    return this.routes.list(query);
  }

  @Get('compliance')
  @ApiOperation({
    summary: 'Route compliance',
    description: 'Stop-completion percentage per rep for a given date.',
  })
  @ApiQuery({ name: 'date', required: true, description: 'Date (YYYY-MM-DD)', example: '2026-05-23' })
  @ApiOkResponse({ description: 'Per-rep completion percentages' })
  compliance(@Query('date') date: string) {
    return this.routes.compliance(date);
  }

  @Get('overdue')
  @ApiOperation({
    summary: 'Overdue (missed) outlets',
    description:
      "A rep's outlets that were missed on an earlier day and not yet covered (most recent past visit still pending, within the carry-forward window). These are auto-added to the next generated route.",
  })
  @ApiQuery({ name: 'repId', required: true, description: 'Rep id (uuid)' })
  @ApiOkResponse({ description: 'Missed-and-uncovered outlets with last-missed date' })
  overdue(@Query('repId', ParseUUIDPipe) repId: string) {
    return this.routes.overdueOutlets(repId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get route plan',
    description: 'Fetch a single route plan with its ordered stops.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Route plan id' })
  @ApiOkResponse({ description: 'The route plan with stops' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.routes.findOne(id);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Create route plan',
    description: 'Create a manual route plan. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Route plan created' })
  create(@Body() dto: CreateRoutePlanDto) {
    return this.routes.createPlan(dto);
  }

  @Post('generate')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Generate routes',
    description: 'Generate optimized route plans (nearest-neighbor) for one or more reps. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Generated route plans' })
  generate(@Body() dto: GenerateRoutesDto) {
    return this.routes.generate(dto);
  }

  @Patch(':id/stops/reorder')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Reorder stops',
    description: 'Reorder the stops within a route plan. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Route plan id' })
  @ApiOkResponse({ description: 'Plan with reordered stops' })
  reorder(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderStopsDto) {
    return this.routes.reorderStops(id, dto);
  }

  @Post(':id/accept')
  @ApiOperation({
    summary: 'Accept route plan',
    description: 'Rep accepts an AI-optimized route plan.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Route plan id' })
  @ApiCreatedResponse({ description: 'Accepted route plan' })
  accept(@Param('id', ParseUUIDPipe) id: string) {
    return this.routes.accept(id);
  }

  @Post('stops/:stopId/visit')
  @ApiOperation({ summary: 'Mark stop visited', description: 'Mark a route stop as visited.' })
  @ApiParam({ name: 'stopId', description: 'Route stop id' })
  @ApiCreatedResponse({ description: 'Stop marked visited' })
  visit(@Param('stopId') stopId: string, @Body() dto: MarkVisitedDto) {
    return this.routes.markVisited(stopId, dto);
  }

  @Post('stops/:stopId/skip')
  @ApiOperation({ summary: 'Mark stop skipped', description: 'Mark a route stop as skipped with a reason.' })
  @ApiParam({ name: 'stopId', description: 'Route stop id' })
  @ApiCreatedResponse({ description: 'Stop marked skipped' })
  skip(@Param('stopId') stopId: string, @Body() dto: MarkSkippedDto) {
    return this.routes.markSkipped(stopId, dto);
  }
}
