import {
  Body,
  Controller,
  Get,
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
import { VanStockMutationDto } from './dto/van-stock.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('van-stock')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reps', version: '1' })
export class VanStockController {
  constructor(private readonly vanStock: VanStockService) {}

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
