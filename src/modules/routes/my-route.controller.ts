import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { JourneyPlanService } from './journey-plan.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * The signed-in salesman's own route (journey plan). Unlike the admin
 * journey-plan controller this is scoped to the authenticated rep, so field
 * users (SALES / DRIVER) can read their day and complete their to-dos.
 */
@ApiTags('my-route')
@ApiBearerAuth()
@Controller({ path: 'my-route', version: '1' })
export class MyRouteController {
  constructor(private readonly journeyPlan: JourneyPlanService) {}

  @Get('today')
  @ApiOperation({
    summary: "Today's outlets",
    description:
      "The signed-in salesman's outlets for today, ordered with notes + to-dos. " +
      "Resolved through the rep's own route cycle, so this is correct on a cycle " +
      'of any length and needs no change on the handset.',
  })
  @ApiOkResponse({ description: "Ordered outlets for today" })
  today(@CurrentUser('repId') repId: string | null) {
    const id = this.journeyPlan.assertSelfRep(repId);
    return this.journeyPlan.dayForDate(id, todayStr());
  }

  @Get('cycle')
  @ApiOperation({
    summary: 'My route cycle',
    description:
      "The rep's cycle length, start date and which day of it today falls on — " +
      'what the handset needs to label days and offer a day picker.',
  })
  @ApiOkResponse({ description: 'Route cycle info' })
  cycle(@CurrentUser('repId') repId: string | null) {
    const id = this.journeyPlan.assertSelfRep(repId);
    return this.journeyPlan.cycle(id);
  }

  @Get('day')
  @ApiOperation({
    summary: 'Outlets for a day of the cycle',
    description:
      "The signed-in salesman's outlets for a given day of their route cycle " +
      '(0..cycleDays-1). On the default 7-day cycle that is 0=Sun..6=Sat.',
  })
  @ApiQuery({
    name: 'day',
    required: false,
    description: 'Day index in the cycle, 0..cycleDays-1',
    example: 0,
  })
  @ApiQuery({
    name: 'weekday',
    required: false,
    deprecated: true,
    description: 'Deprecated alias for `day`, kept for older handsets.',
    example: 0,
  })
  @ApiOkResponse({ description: 'Ordered outlets for that day' })
  day(
    @CurrentUser('repId') repId: string | null,
    @Query('day') day?: string,
    @Query('weekday') weekday?: string,
  ) {
    const id = this.journeyPlan.assertSelfRep(repId);
    const raw = day ?? weekday;
    const parsed = Number(raw);
    if (raw === undefined || !Number.isInteger(parsed)) {
      throw new BadRequestException('day must be an integer');
    }
    return this.journeyPlan.day(id, parsed);
  }

  @Post(':customerId/todo-done')
  @ApiOperation({
    summary: 'Complete an outlet to-do',
    description: "Mark this outlet's to-do done for today (called by the salesman on visit).",
  })
  @ApiOkResponse({ description: 'The updated outlet row' })
  markTodoDone(
    @CurrentUser('repId') repId: string | null,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    const id = this.journeyPlan.assertSelfRep(repId);
    return this.journeyPlan.markTodoDone(id, customerId);
  }
}

/**
 * Server-local date as YYYY-MM-DD — the same clock `todo_done_date` is stamped
 * against, so "today's route" and "to-do done today" can never disagree about
 * which day it is.
 */
function todayStr(): string {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, '0');
  const d = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}
