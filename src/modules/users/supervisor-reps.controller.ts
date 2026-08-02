import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AssignRepsDto } from './dto/assign-reps.dto';
import { SupervisorRepsService } from './supervisor-reps.service';

/**
 * Main admin assigns reps to a dashboard user, making that user a supervisor
 * over exactly those reps.
 *
 * Admin-only, without exception: a supervisor able to reach these routes could
 * assign themselves more reps and widen their own scope.
 *
 * Assignment changes are recorded by the global audit interceptor — the PUT is
 * a mutating request on /users/:id, so actor, target user and the submitted
 * repIds all land in `audit_log` (spec §8.4) with no extra wiring.
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin')
@Controller({ path: 'users', version: '1' })
export class SupervisorRepsController {
  constructor(private readonly service: SupervisorRepsService) {}

  @Get(':id/reps')
  @ApiOperation({
    summary: 'List a user’s supervised reps',
    description:
      'The rep ids this dashboard user supervises. Empty means unscoped-by-assignment — which, under deny-by-default, means they will see no rep data at all.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiOkResponse({ description: 'Assigned rep ids' })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ repIds: string[] }> {
    return { repIds: await this.service.list(id) };
  }

  @Put(':id/reps')
  @ApiOperation({
    summary: 'Replace a user’s supervised reps',
    description:
      'Replaces the whole set. Send an empty array to clear the assignment. Rejected for main admins (never scoped) and for salesman logins (one level only).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'User id' })
  @ApiOkResponse({ description: 'The assignment after the change' })
  async replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRepsDto,
  ): Promise<{ repIds: string[] }> {
    return { repIds: await this.service.replace(id, dto.repIds) };
  }
}
