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

import { ProductsService } from './products.service';
import { PricingService } from './pricing.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { QuotePriceDto } from './dto/price-rule.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('products')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly pricing: PricingService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List products',
    description: 'List catalog products with optional filters (category, tax type, search).',
  })
  @ApiOkResponse({ description: 'Product list' })
  list(@Query() query: ListProductsQuery) {
    return this.products.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product', description: 'Fetch a single product by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiOkResponse({ description: 'The product' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.findOne(id);
  }

  @Post(':id/quote')
  @ApiOperation({
    summary: 'Quote price',
    description:
      'Compute the effective unit price for a product at a quantity, applying any matching price rules (optionally customer-specific).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiCreatedResponse({ description: 'Quoted price breakdown' })
  quote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: QuotePriceDto) {
    return this.pricing.quote(id, dto.qty, dto.customerId);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create product', description: 'Create a product. Admin/manager only.' })
  @ApiCreatedResponse({ description: 'Product created' })
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Update product', description: 'Update a product. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiOkResponse({ description: 'Updated product' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete product', description: 'Soft-delete a product. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiNoContentResponse({ description: 'Product soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.products.softDelete(id);
  }
}
