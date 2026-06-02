import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { UnitsService } from './units.service';
import {
  CreateItemUnitDto,
  UpdateItemUnitDto,
} from './dto/item-unit.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('item-units')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ version: '1' })
export class ItemUnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get('products/:productId/units')
  @ApiOperation({
    summary: "List an item's unit mappings",
    description: 'Each row: unit + base_qty (factor) + per-unit barcode + per-unit price + isBase.',
  })
  @ApiParam({ name: 'productId', format: 'uuid', description: 'Item (product) id' })
  @ApiOkResponse({ description: 'item_units rows for this item' })
  list(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.units.listForItem(productId);
  }

  @Post('products/:productId/units')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Attach a unit to an item',
    description: 'Adds a unit mapping with factor + barcode + price. Admin/manager only.',
  })
  @ApiParam({ name: 'productId', format: 'uuid', description: 'Item (product) id' })
  @ApiCreatedResponse({ description: 'Mapping created' })
  attach(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateItemUnitDto,
  ) {
    return this.units.attach(productId, dto);
  }

  @Patch('products/:productId/units/:unitId')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: "Update an item's unit mapping",
    description: 'Change base_qty, barcode, price, or isBase. (To change the unit itself, detach + reattach.) Admin/manager only.',
  })
  @ApiParam({ name: 'productId', format: 'uuid', description: 'Item (product) id' })
  @ApiParam({ name: 'unitId', format: 'uuid', description: 'Unit id' })
  @ApiOkResponse({ description: 'Updated mapping' })
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() dto: UpdateItemUnitDto,
  ) {
    return this.units.update_itemUnit(productId, unitId, dto);
  }

  @Delete('products/:productId/units/:unitId')
  @Roles('admin', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach a unit from an item', description: 'Admin/manager only.' })
  @ApiParam({ name: 'productId', format: 'uuid', description: 'Item (product) id' })
  @ApiParam({ name: 'unitId', format: 'uuid', description: 'Unit id' })
  @ApiNoContentResponse({ description: 'Mapping removed' })
  async detach(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ) {
    await this.units.detach(productId, unitId);
  }

  @Get('item-units/barcode/:barcode')
  @ApiOperation({
    summary: 'Lookup by barcode',
    description: 'Resolve a per-unit barcode to its item + unit mapping (mobile scanner).',
  })
  @ApiParam({ name: 'barcode', description: 'Per-unit barcode' })
  @ApiOkResponse({ description: 'The matching item_unit row (with item + unit)' })
  async byBarcode(@Param('barcode') barcode: string) {
    const row = await this.units.findForItemByBarcode(barcode);
    if (!row) throw new NotFoundException(`No unit found for barcode ${barcode}`);
    return row;
  }
}
