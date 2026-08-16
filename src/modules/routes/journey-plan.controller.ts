import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { JourneyPlanService } from './journey-plan.service';
import {
  BulkSetJourneyPlanDto,
  SetRouteCycleDto,
  UpsertJourneyPlanDto,
} from './dto/journey-plan.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('journey-plan')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin', 'manager')
@Controller({ path: 'reps/:repId/journey-plan', version: '1' })
export class JourneyPlanController {
  constructor(private readonly journeyPlan: JourneyPlanService) {}

  @Get()
  @ApiOperation({
    summary: "List a rep's journey plan",
    description: 'All per-outlet visit schedules for the rep. Admin/manager only.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Journey-plan entries' })
  list(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.journeyPlan.list(repId);
  }

  @Get('day')
  @ApiOperation({
    summary: 'Outlets for a rep on a day of their cycle',
    description:
      'Active outlets the rep visits on the given day of their route cycle ' +
      '(0..cycleDays-1), ordered for the day map view. Admin/manager only.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiQuery({ name: 'day', required: false, description: 'Day index, 0..cycleDays-1', example: 0 })
  @ApiQuery({
    name: 'weekday',
    required: false,
    deprecated: true,
    description: 'Deprecated alias for `day`.',
    example: 0,
  })
  @ApiOkResponse({ description: 'Ordered outlets for that day' })
  day(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Query('day') day?: string,
    @Query('weekday') weekday?: string,
  ) {
    const raw = day ?? weekday;
    const parsed = Number(raw);
    if (raw === undefined || !Number.isInteger(parsed)) {
      throw new BadRequestException('day must be an integer');
    }
    return this.journeyPlan.day(repId, parsed);
  }

  @Get('cycle')
  @ApiOperation({
    summary: "Read a rep's route cycle",
    description:
      'Cycle length, anchor date, name, and which day of the cycle today falls ' +
      'on — what the dashboard needs to draw the day columns. Admin/manager only.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Route cycle info' })
  cycle(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.journeyPlan.cycle(repId);
  }

  @Put('cycle')
  @ApiOperation({
    summary: "Change a rep's route cycle",
    description:
      'Set the cycle length, start date or name. Shrinking the cycle is refused ' +
      'when outlets are scheduled beyond the new last day — the response lists ' +
      'them — unless `force` is sent. Admin/manager only.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'The cycle after the change' })
  setCycle(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: SetRouteCycleDto,
  ) {
    return this.journeyPlan.setCycle(repId, dto);
  }

  @Put(':customerId')
  @ApiOperation({
    summary: 'Set an outlet schedule',
    description:
      "Create or update one outlet's visit weekdays in the rep's journey plan. Admin/manager only.",
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiParam({ name: 'customerId', format: 'uuid', description: 'Outlet (customer) id' })
  @ApiOkResponse({ description: 'The saved schedule entry' })
  upsert(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpsertJourneyPlanDto,
  ) {
    return this.journeyPlan.upsert(repId, customerId, dto);
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Replace whole journey plan',
    description:
      "Replace the rep's entire journey plan with the provided set (outlets not listed are removed). Admin/manager only.",
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'The full journey plan after replacement' })
  bulkSet(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: BulkSetJourneyPlanDto,
  ) {
    return this.journeyPlan.bulkSet(repId, dto);
  }

  @Delete(':customerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an outlet schedule',
    description: "Remove one outlet from the rep's journey plan. Admin/manager only.",
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiParam({ name: 'customerId', format: 'uuid', description: 'Outlet (customer) id' })
  @ApiNoContentResponse({ description: 'Schedule entry removed' })
  remove(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.journeyPlan.remove(repId, customerId);
  }
}
