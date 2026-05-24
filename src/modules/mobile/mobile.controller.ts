import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { MobileService } from './mobile.service';
import { MobileContextGuard } from './mobile-context.guard';
import { MobileCtx, MobileContext } from './mobile.context';
import {
  CompanyMetaDto,
  ItemBalanceRowDto,
  ItemDto,
  SalesmanDto,
} from './dto/mobile.dto';

/**
 * Mobile BFF — read endpoints shaped to the frontend contract (`12-frontend_API`).
 * Field names follow that contract; responses use the standard
 * `{ success, data, timestamp }` envelope. `companyNumber` + `salesmanCode` are
 * required on every request (query or X-Company-Number / X-Salesman-Code headers)
 * and validated by MobileContextGuard.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Number', required: false, description: 'Alt to companyNumber query param' })
@ApiHeader({ name: 'X-Salesman-Code', required: false, description: 'Alt to salesmanCode query param' })
@UseGuards(MobileContextGuard)
@Controller({ path: 'mobile', version: '1' })
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @Get('salesman/:salesmanCode')
  @ApiOperation({
    summary: 'Get salesman',
    description: 'Salesman profile + assigned route + van store + default price phase.',
  })
  @ApiParam({ name: 'salesmanCode', description: 'Salesman code (e.g. S012)' })
  @ApiQuery({ name: 'companyNumber', required: false, description: 'Company id (or X-Company-Number header)' })
  @ApiOkResponse({ type: SalesmanDto })
  getSalesman(@MobileCtx() ctx: MobileContext) {
    return this.mobile.getSalesman(ctx.rep, ctx.companyNumber);
  }

  @Get('company/meta')
  @ApiOperation({
    summary: 'Get company metadata',
    description: 'Company name, tax number, phone, and logo.',
  })
  @ApiQuery({ name: 'companyNumber', required: false })
  @ApiQuery({ name: 'salesmanCode', required: false })
  @ApiOkResponse({ type: CompanyMetaDto })
  getCompanyMeta(@MobileCtx() ctx: MobileContext) {
    return this.mobile.getCompanyMeta(ctx.companyNumber, ctx.salesmanCode);
  }

  @Get('items/:itemCode')
  @ApiOperation({
    summary: 'Get item',
    description: 'Full item detail incl. units (per-unit price + van stock) and price list.',
  })
  @ApiParam({ name: 'itemCode', description: 'Item code / number (e.g. 23232)' })
  @ApiQuery({ name: 'companyNumber', required: false })
  @ApiQuery({ name: 'salesmanCode', required: false })
  @ApiOkResponse({ type: ItemDto })
  getItem(@Param('itemCode') itemCode: string, @MobileCtx() ctx: MobileContext) {
    return this.mobile.getItem(itemCode, ctx.rep, ctx.companyNumber, ctx.salesmanCode);
  }

  @Get('itemBalance')
  @ApiOperation({
    summary: 'Get item balance',
    description: 'Stock balance for an item across stores, or one store via storeNo. Always an array.',
  })
  @ApiQuery({ name: 'companyNumber', required: false })
  @ApiQuery({ name: 'salesmanCode', required: false })
  @ApiQuery({ name: 'itemNumber', required: true, description: 'Item number to query' })
  @ApiQuery({ name: 'storeNo', required: false, description: 'Filter by store number; omit for all stores' })
  @ApiOkResponse({ type: [ItemBalanceRowDto] })
  getItemBalance(
    @Query('itemNumber') itemNumber: string,
    @Query('storeNo') storeNo: string | undefined,
    @MobileCtx() ctx: MobileContext,
  ) {
    if (!itemNumber) throw new BadRequestException('itemNumber is required');
    return this.mobile.getItemBalance(itemNumber, storeNo, ctx.companyNumber, ctx.salesmanCode);
  }
}
