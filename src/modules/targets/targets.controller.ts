import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TargetsService } from './targets.service';
import { UpsertTargetDto } from './dto/upsert-target.dto';

@ApiTags('targets')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'targets', version: '1' })
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get('me')
  @ApiOperation({
    summary: "The signed-in salesman's own target + progress",
    description:
      "The authenticated salesman's target for the month (defaults to the current month) with actual sale amount/qty and progress. Used by the mobile app.",
  })
  @ApiOkResponse({ description: 'The salesman target row' })
  me(
    @CurrentUser('repId') repId: string | null,
    @Query('year') yearStr?: string,
    @Query('month') monthStr?: string,
  ) {
    if (!repId) {
      throw new ForbiddenException('This account is not linked to a salesman.');
    }
    const now = new Date();
    const year = yearStr ? Number(yearStr) : now.getFullYear();
    const month = monthStr ? Number(monthStr) : now.getMonth() + 1;
    return this.targets.getForRep(repId, year, month);
  }

  @Get()
  @Roles('admin', 'manager', 'supervisor')
  @ApiOperation({
    summary: 'Monthly sales targets vs actuals',
    description: 'Every active salesman with their target for the month plus actual sale amount/qty and progress.',
  })
  @ApiOkResponse({ description: 'Target rows' })
  list(
    @Query('year', ParseIntPipe) year: number,
    @Query('month', ParseIntPipe) month: number,
  ) {
    return this.targets.list(year, month);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Set a salesman target (create or replace) for a month' })
  @ApiOkResponse({ description: 'The saved target' })
  upsert(@Body() dto: UpsertTargetDto) {
    return this.targets.upsert(dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Remove a salesman target' })
  @ApiOkResponse({ description: '{ deleted: true }' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.targets.remove(id);
  }
}
