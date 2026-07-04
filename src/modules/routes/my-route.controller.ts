import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
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
    description: "The signed-in salesman's outlets for today, ordered with notes + to-dos.",
  })
  @ApiOkResponse({ description: "Ordered outlets for today" })
  today(@CurrentUser('repId') repId: string | null) {
    const id = this.journeyPlan.assertSelfRep(repId);
    return this.journeyPlan.day(id, new Date().getDay());
  }

  @Get('day')
  @ApiOperation({
    summary: "Outlets for a weekday",
    description: "The signed-in salesman's outlets for a given weekday (0=Sun..6=Sat).",
  })
  @ApiQuery({ name: 'weekday', description: '0=Sunday .. 6=Saturday', example: 0 })
  @ApiOkResponse({ description: 'Ordered outlets for that weekday' })
  day(
    @CurrentUser('repId') repId: string | null,
    @Query('weekday', ParseIntPipe) weekday: number,
  ) {
    const id = this.journeyPlan.assertSelfRep(repId);
    return this.journeyPlan.day(id, weekday);
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
