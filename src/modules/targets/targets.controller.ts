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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RepScopeService } from '../users/rep-scope.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TargetsService } from './targets.service';
import { UpsertTargetDto } from './dto/upsert-target.dto';
import { ItemTargetsService } from './item-targets.service';
import { PutItemTargetsDto } from './dto/item-targets.dto';

@ApiTags('targets')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'targets', version: '1' })
export class TargetsController {
  constructor(
    private readonly targets: TargetsService,
    private readonly repScope: RepScopeService,
    private readonly itemTargets: ItemTargetsService,
  ) {}

  // ── Item targets (Program features → item targets; measured, not paid) ────

  @Get('items')
  @Roles('admin', 'manager', 'supervisor')
  @ApiOperation({
    summary: 'Item targets for a month with what was achieved',
    description: '{ items: [] } while item targets are switched off in Program features.',
  })
  @ApiOkResponse({ description: '{ items: ItemTargetLine[] }' })
  async listItems(
    @Query('year', ParseIntPipe) year: number,
    @Query('month', ParseIntPipe) month: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('repId', new ParseUUIDPipe({ optional: true })) repId?: string,
  ) {
    return this.itemTargets.list(year, month, repId, await this.repScope.visibleRepIds(user));
  }

  @Put('items')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: "Replace one salesman's item targets for a month",
    description:
      'Upserts the lines sent and deletes the ones left out. 400 ITEM_TARGET_INVALID names each ' +
      'problem; 403 FEATURE_DISABLED while item targets are off.',
  })
  @ApiOkResponse({ description: "{ items: ItemTargetLine[] } — that rep's month" })
  putItems(@Body() dto: PutItemTargetsDto, @CurrentUser('sub') userId: string | null) {
    return this.itemTargets.replace(dto, userId ?? null);
  }

  @Delete('items/:id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Remove one item target' })
  @ApiOkResponse({ description: '{ deleted: true }' })
  removeItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.itemTargets.remove(id);
  }

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

  @Get('me/history')
  @ApiOperation({
    summary: "The signed-in salesman's target history",
    description:
      "The authenticated salesman's targets for the last `months` months (default 6, most-recent first), each with actuals + progress. Read-only; used by the mobile app.",
  })
  @ApiOkResponse({ description: 'Target history rows' })
  myHistory(
    @CurrentUser('repId') repId: string | null,
    @Query('months') monthsStr?: string,
  ) {
    if (!repId) {
      throw new ForbiddenException('This account is not linked to a salesman.');
    }
    return this.targets.historyForRep(repId, monthsStr ? Number(monthsStr) : 6);
  }

  @Get()
  @Roles('admin', 'manager', 'supervisor')
  @ApiOperation({
    summary: 'Monthly sales targets vs actuals',
    description: 'Every active salesman with their target for the month plus actual sale amount/qty and progress.',
  })
  @ApiOkResponse({ description: 'Target rows' })
  async list(
    @Query('year', ParseIntPipe) year: number,
    @Query('month', ParseIntPipe) month: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.targets.list(year, month, await this.repScope.visibleRepIds(user));
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
