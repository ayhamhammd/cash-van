import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { MobileService } from './mobile.service';
import { ItemBalanceRowDto } from './dto/mobile.dto';

/**
 * ORDER stock for the salesman app — JWT-authed, WITHOUT the MobileContext headers.
 *
 * The app signs every request with the rep's bearer token but does not send the
 * `companyNumber` / `salesmanCode` that MobileController's guard demands (that guard
 * predates the app's JWT auth). The ORDER picker only needs the MAIN STORE's items
 * and quantities — which do not depend on which rep is asking — so this exposes
 * exactly that behind the ordinary JWT, instead of forcing the app to carry a
 * company header it never had.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@Controller({ path: 'mobile-order', version: '1' })
export class MobileOrderController {
  constructor(private readonly mobile: MobileService) {}

  @Get('stock')
  @ApiOperation({
    summary: 'Order stock (main store) — JWT-authed',
    description:
      "Item quantities for the ORDER flow, drawn from the main store live from the " +
      'ERP. Same data as GET /mobile/order-stock but authenticated by the bearer ' +
      'token alone (no companyNumber/salesmanCode). Omit itemNumber for all items.',
  })
  @ApiQuery({ name: 'itemNumber', required: false, description: 'Narrow to one item; omit for all' })
  @ApiOkResponse({ type: [ItemBalanceRowDto] })
  stock(@Query('itemNumber') itemNumber?: string): Promise<ItemBalanceRowDto[]> {
    // companyNumber/salesmanCode only echo back on each row (the app reads itemNumber
    // + itemQty), so empty strings are fine here.
    return this.mobile.getOrderStock(itemNumber, '', '');
  }
}
