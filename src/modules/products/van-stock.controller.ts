import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { VanStockService } from './van-stock.service';
import { VanStockMutationDto, VanStockSnapshotDto } from './dto/van-stock.dto';
import { RepScopeService } from '../users/rep-scope.service';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('van-stock')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reps', version: '1' })
export class VanStockController {
  constructor(
    private readonly vanStock: VanStockService,
    private readonly repScope: RepScopeService,
  ) {}

  @Get(':repId/van-stock')
  @ApiOperation({
    summary: 'Get van stock',
    description: 'Current van stock for a rep, including per-line stockout flags.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Van stock lines with stockout flags' })
  forRep(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.vanStock.forRep(repId);
  }

  @Post(':repId/van-stock/snapshot')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Van stock snapshot for a handset',
    description:
      'The van, plus which of the handset\'s pending documents that balance already ' +
      'contains — both read in one transaction. See docs/SPEC-single-stock-model.md §4.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: '{ asOf, rows, applied }' })
  async snapshot(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: VanStockSnapshotDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // A salesman sees his own van only; an office user within their scope.
    await this.repScope.assertCanSeeRep(user, repId);
    return this.vanStock.snapshot(repId, dto.pending);
  }

  @Post(':repId/van-stock/load')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Load van stock',
    description: 'Load products onto a rep van (adds quantity). Admin/manager only.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Updated van stock after load' })
  load(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: VanStockMutationDto,
  ) {
    return this.vanStock.load(repId, dto.items);
  }

  @Post(':repId/van-stock/return')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Return van stock',
    description: 'Return products from a rep van (subtracts quantity). Admin/manager only.',
  })
  @ApiParam({ name: 'repId', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Updated van stock after return' })
  return(
    @Param('repId', ParseUUIDPipe) repId: string,
    @Body() dto: VanStockMutationDto,
  ) {
    return this.vanStock.return(repId, dto.items);
  }
}
