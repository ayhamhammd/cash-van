import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CustomerPricesService } from './customer-prices.service';

/**
 * Read-only customer contract prices (mirrored from the ERP). Any authenticated
 * user: the mobile app pulls them for its offline cache, the dashboard shows them
 * on the customer profile. Editing lives in the ERP.
 */
@ApiTags('customer-prices')
@ApiBearerAuth()
@Controller({ path: 'customer-prices', version: '1' })
export class CustomerPricesController {
  constructor(private readonly service: CustomerPricesService) {}

  @Get()
  @ApiOperation({
    summary: 'Customer contract/list prices (ERP mirror)',
    description:
      'Per-customer contracted unit prices (fils) with the manual-edit flag. Filter by customerId; otherwise a full offset-paginated sweep for offline sync.',
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
}
