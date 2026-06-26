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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ItemCart } from '../items/entities/item-cart.entity';
import { ProductsService } from './products.service';
import { PricingService } from './pricing.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { QuotePriceDto } from './dto/price-rule.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';

/** Rewrites an item's image to the cash-van proxy URL the app/browser can reach. */
function proxyImageUrl(req: Request, itemNumber: string): string {
  const origin = `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/v1/products/image/${encodeURIComponent(itemNumber)}`;
}

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
  async list(@Query() query: ListProductsQuery, @Req() req: Request) {
    const result = await this.products.list(query);
    // Serve images through THIS host (the app/browser already reaches it), not the
    // ERP host baked into the stored URL (often 127.0.0.1 → unreachable from a device).
    for (const it of result.items as Array<{ itemNumber: string; imageUrl?: string | null }>) {
      if (it.imageUrl) it.imageUrl = proxyImageUrl(req, it.itemNumber);
    }
    return result;
  }

  @Public()
  @Get('image/:itemNumber')
  @ApiOperation({
    summary: 'Item image (proxy)',
    description:
      "Streams the item's image from wherever it's hosted (the ERP), via this host, so devices that can't reach the ERP directly still load it. Public (Coil/<img> send no auth).",
  })
  @ApiParam({ name: 'itemNumber' })
  async image(@Param('itemNumber') itemNumber: string, @Res() res: Response) {
    const img = await this.products.imageBytes(itemNumber);
    if (!img) {
      res.status(HttpStatus.NOT_FOUND).end();
      return;
    }
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(img.buffer);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product', description: 'Fetch a single product by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiOkResponse({ description: 'The product' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const item = (await this.products.findOne(id)) as ItemCart & { imageUrl?: string | null };
    if (item.imageUrl) item.imageUrl = proxyImageUrl(req, item.itemNumber);
    return item;
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
  @UseGuards(ErpReadOnlyGuard)
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create product', description: 'Create a product. Admin/manager only.' })
  @ApiCreatedResponse({ description: 'Product created' })
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch(':id')
  @UseGuards(ErpReadOnlyGuard)
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Update product', description: 'Update a product. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiOkResponse({ description: 'Updated product' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(ErpReadOnlyGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete product', description: 'Soft-delete a product. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product id' })
  @ApiNoContentResponse({ description: 'Product soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.products.softDelete(id);
  }
}
