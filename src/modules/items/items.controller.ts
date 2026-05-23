import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { ItemCartService } from './item-cart.service';
import { ItemSwitchesService } from './item-switches.service';
import { ExpiryItemsService } from './expiry-items.service';
import { ItemBalanceService } from './item-balance.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { CreateItemSwitchDto } from './dto/create-item-switch.dto';
import { CreateExpiryItemDto } from './dto/create-expiry-item.dto';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@ApiTags('items')
@ApiBearerAuth()
@Controller({ path: 'items', version: '1' })
export class ItemsController {
  constructor(
    private readonly itemCart: ItemCartService,
    private readonly itemSwitches: ItemSwitchesService,
    private readonly expiryItems: ExpiryItemsService,
    private readonly itemBalance: ItemBalanceService,
  ) {}

  // -------- Items / catalog ---------
  @Post()
  @RequirePermissions('canAddItems')
  @ApiOperation({
    summary: 'Create item',
    description: 'Create a catalog item. Requires the canAddItems permission.',
  })
  @ApiCreatedResponse({ description: 'Item created' })
  create(@Body() dto: CreateItemDto) {
    return this.itemCart.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List items', description: 'Paginated catalog item list.' })
  @ApiOkResponse({ description: 'Paginated item list' })
  list(@Query() query: PaginationDto) {
    return this.itemCart.paginate(query);
  }

  @Get('barcode/:barcode')
  @ApiOperation({
    summary: 'Find item by barcode',
    description: 'Look up a catalog item by its barcode.',
  })
  @ApiParam({ name: 'barcode', description: 'Item barcode', example: 'B-1001' })
  @ApiOkResponse({ description: 'The matching catalog item' })
  findByBarcode(@Param('barcode') barcode: string) {
    return this.itemCart.findByBarcode(barcode);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get item', description: 'Fetch a single catalog item by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Item id' })
  @ApiOkResponse({ description: 'The item' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.itemCart.findOneOrThrow(id);
  }

  @Patch(':id')
  @RequirePermissions('canAddItems')
  @ApiOperation({
    summary: 'Update item',
    description: 'Update a catalog item. Requires the canAddItems permission.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Item id' })
  @ApiOkResponse({ description: 'Updated item' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.itemCart.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete item', description: 'Soft-delete a catalog item.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Item id' })
  @ApiNoContentResponse({ description: 'Item soft-deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.itemCart.remove(id);
  }

  // -------- Unit switches (carton/piece/box) ---------
  @Post('switches')
  @RequirePermissions('canAddItems')
  @ApiOperation({
    summary: 'Create unit switch',
    description:
      'Create a unit-conversion row (e.g. carton ↔ piece) for an item. Requires canAddItems.',
  })
  @ApiCreatedResponse({ description: 'Unit switch created' })
  createSwitch(@Body() dto: CreateItemSwitchDto) {
    return this.itemSwitches.create(dto);
  }

  @Get(':itemNumber/switches')
  @ApiOperation({
    summary: 'List unit switches',
    description: 'List all unit-conversion rows for an item.',
  })
  @ApiParam({ name: 'itemNumber', description: 'Item number', example: 'IT-1001' })
  @ApiOkResponse({ description: 'Unit switches for the item' })
  listSwitches(@Param('itemNumber') itemNumber: string) {
    return this.itemSwitches.listForItem(itemNumber);
  }

  @Get('switches/barcode/:barcode')
  @ApiOperation({
    summary: 'Find unit switch by barcode',
    description: 'Look up a unit-conversion row by its barcode.',
  })
  @ApiParam({ name: 'barcode', description: 'Unit switch barcode', example: 'B-1001-CTN' })
  @ApiOkResponse({ description: 'The matching unit switch' })
  switchByBarcode(@Param('barcode') barcode: string) {
    return this.itemSwitches.findByBarcode(barcode);
  }

  @Delete('switches/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete unit switch', description: 'Delete a unit-conversion row.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Unit switch id' })
  @ApiNoContentResponse({ description: 'Unit switch deleted' })
  removeSwitch(@Param('id', ParseUUIDPipe) id: string) {
    return this.itemSwitches.remove(id);
  }

  // -------- Expiry tracking ---------
  @Post('expiry')
  @RequirePermissions('canEditExpiry')
  @ApiOperation({
    summary: 'Create expiry record',
    description: 'Record a batch expiry date for an item. Requires canEditExpiry.',
  })
  @ApiCreatedResponse({ description: 'Expiry record created' })
  createExpiry(@Body() dto: CreateExpiryItemDto) {
    return this.expiryItems.create(dto);
  }

  @Get('expiry/list')
  @ApiOperation({ summary: 'List expiry records', description: 'List all batch expiry records.' })
  @ApiOkResponse({ description: 'Expiry records' })
  listExpiry() {
    return this.expiryItems.list();
  }

  @Get('expiry/before/:date')
  @ApiOperation({
    summary: 'Expiring before date',
    description: 'List batches expiring before the given date.',
  })
  @ApiParam({ name: 'date', description: 'Cut-off date (YYYY-MM-DD)', example: '2026-12-31' })
  @ApiOkResponse({ description: 'Batches expiring before the date' })
  expiringBefore(@Param('date') date: string) {
    return this.expiryItems.expiringBefore(date);
  }

  @Delete('expiry/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete expiry record', description: 'Delete a batch expiry record.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Expiry record id' })
  @ApiNoContentResponse({ description: 'Expiry record deleted' })
  removeExpiry(@Param('id', ParseUUIDPipe) id: string) {
    return this.expiryItems.remove(id);
  }

  // -------- Live stock view ---------
  @Get('balance/list')
  @ApiOperation({
    summary: 'List item balances',
    description: 'Read the item_balance view (quantity per item per store).',
  })
  @ApiQuery({ name: 'itemNumber', required: false, description: 'Filter by item number', example: 'IT-1001' })
  @ApiQuery({ name: 'stockNumber', required: false, description: 'Filter by store/stock number', example: 'ST-01' })
  @ApiOkResponse({ description: 'Item balance rows' })
  balances(
    @Query('itemNumber') itemNumber?: string,
    @Query('stockNumber') stockNumber?: string,
  ) {
    return this.itemBalance.list({ itemNumber, stockNumber });
  }
}
