import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PriceListsService } from './price-lists.service';
import {
  AssignPriceListDto,
  CreatePriceListDto,
  SetPriceListItemDto,
  UpdatePriceListDto,
} from './dto/price-list.dto';

/**
 * Price lists (named lists of per-item prices) + per-customer assignment.
 * Reads are open (mobile app pulls them for its offline cache + dashboard shows
 * them); writes are admin-only. Money is fils.
 */
@ApiTags('price-lists')
@ApiBearerAuth()
@Controller({ path: 'price-lists', version: '1' })
export class PriceListsController {
  constructor(private readonly service: PriceListsService) {}

  @Get()
  @ApiOperation({ summary: 'List price lists', description: 'Each with item + customer counts.' })
  @ApiOkResponse({ description: 'Price lists' })
  list() {
    return this.service.list();
  }

  @Get('full')
  @ApiOperation({
    summary: 'All active lists + their item prices',
    description: 'One payload for the mobile app offline cache. Any authenticated user.',
  })
  @ApiOkResponse({ description: 'Lists with items' })
  full() {
    return this.service.full();
  }

  @Get(':id/items')
  @ApiOperation({ summary: "A price list's item prices", description: 'With catalog base price.' })
  items(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listItems(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a price list', description: 'Admin only.' })
  create(@Body() dto: CreatePriceListDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Rename / (de)activate a price list', description: 'Admin only.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceListDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Delete a price list',
    description: 'Removes the list, its item prices, and unassigns its customers. Admin only.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  @Post(':id/items')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Set an item price in a list', description: 'Upsert (fils). Admin only.' })
  setItem(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPriceListItemDto) {
    return this.service.setItem(id, dto);
  }

  @Delete(':id/items/:itemId')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Remove an item from a list', description: 'Admin only.' })
  removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.removeItem(id, itemId);
  }

  @Post('assign')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Assign a customer to a price list',
    description: 'Set priceListId to null to clear. Admin only.',
  })
  assign(@Body() dto: AssignPriceListDto) {
    return this.service.assignCustomer(dto.customerId, dto.priceListId ?? null);
  }
}
