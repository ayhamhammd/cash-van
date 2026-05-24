import {
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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { JourneyPlanService } from './journey-plan.service';
import {
  BulkSetJourneyPlanDto,
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
