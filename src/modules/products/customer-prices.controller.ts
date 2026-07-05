import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CustomerPricesService } from './customer-prices.service';
import { UpsertCustomerPriceDto } from './dto/upsert-customer-price.dto';

/**
 * Customer contract prices. Reads (any authenticated user) serve the mobile app's
 * offline cache and the dashboard customer profile — the union of ERP-mirrored
 * rows and dashboard-authored ('local') overrides. Writes are admin-only and
 * store a local override the ERP sync never overwrites.
 */
@ApiTags('customer-prices')
@ApiBearerAuth()
@Controller({ path: 'customer-prices', version: '1' })
export class CustomerPricesController {
  constructor(private readonly service: CustomerPricesService) {}

  @Get()
  @ApiOperation({
    summary: 'Customer contract/list prices',
    description:
      'Per-customer contracted unit prices (fils) with the manual-edit flag + origin (erp | local). Filter by customerId; otherwise a full offset-paginated sweep for offline sync.',
  })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({ description: '{ items, total }' })
  list(
    @Query('customerId') customerId?: string,
    @Query('limit', new DefaultValuePipe(500), ParseIntPipe) limit = 500,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    return this.service.list({
      customerId: customerId || undefined,
      limit: Math.min(Math.max(limit, 1), 1000),
      offset: Math.max(offset, 0),
    });
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Set a customer price (local override)',
    description:
      "Create/update a dashboard-authored contract price (fils) for (customer, product). Stored as origin='local' so the ERP sync never overwrites it; the web quote() and the app read it from the DB. Admin only.",
  })
  @ApiOkResponse({ description: 'The saved customer price row' })
  upsert(@Body() dto: UpsertCustomerPriceDto) {
    return this.service.upsert(dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Delete a customer price',
    description: 'Remove a customer price row by id. Admin only.',
  })
  @ApiOkResponse({ description: '{ deleted: true }' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
