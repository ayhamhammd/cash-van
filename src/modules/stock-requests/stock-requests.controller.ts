import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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

import { StockRequestsService } from './stock-requests.service';
import {
  ApproveStockRequestDto,
  CreateStockRequestDto,
  ListStockRequestsQueryDto,
  RejectStockRequestDto,
  AttachTransferDto,
} from './dto/stock-request.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RepScopeService } from '../users/rep-scope.service';

@ApiTags('stock-requests')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'stock-requests', version: '1' })
export class StockRequestsController {
  constructor(
    private readonly service: StockRequestsService,
    private readonly repScope: RepScopeService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Request stock for the van',
    description:
      "A salesman asks for items to be loaded onto their own van. The destination is the caller's " +
      'assigned van store; the source warehouse is chosen by the manager at approval time.',
  })
  @ApiCreatedResponse({ description: 'The pending request, with its lines' })
  create(@Body() dto: CreateStockRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Stock request queue', description: 'Newest first, rep-scoped.' })
  @ApiOkResponse({ description: '{ items, total }' })
  async list(
    @Query() q: ListStockRequestsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(q, await this.repScope.visibleRepIds(user));
  }

  @Get('mine')
  @ApiOperation({
    summary: 'My stock requests',
    description: "The calling salesman's own requests, newest first. The app polls this for decisions.",
  })
  @ApiOkResponse({ description: 'StockRequest[]' })
  mine(@CurrentUser('sub') userId: string) {
    return this.service.listMine(userId);
  }

  @Get('main-store-stock')
  @ApiOperation({
    summary: 'Main-store availability',
    description:
      "Current stock in the main depot per pool — what a van load can draw from. " +
      'The app shows it beside each item when requesting, and create() rejects a ' +
      'request for more than this.',
  })
  @ApiOkResponse({ description: '{ storeNumber, storeName, items[] }' })
  mainStoreStock() {
    return this.service.mainStoreStock();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Request detail, with lines' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'StockRequest' })
  one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.findOne(id, user);
  }

  @Post(':id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Approve, in full or in part',
    description:
      'Chooses the source warehouse and, optionally, a granted quantity per line. Lines left out ' +
      'are granted in full. Approval does NOT move van stock — that happens when the salesman ' +
      'confirms receipt.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Approved request' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveStockRequestDto,
    @CurrentUser() reviewer: AuthenticatedUser,
  ) {
    return this.service.approve(id, dto, reviewer);
  }

  @Post(':id/reject')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Reject with a reason (shown verbatim to the salesman)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Rejected request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectStockRequestDto,
    @CurrentUser() reviewer: AuthenticatedUser,
  ) {
    return this.service.reject(id, dto.reason, reviewer);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Salesman withdraws their own pending request' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Cancelled request' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('sub') userId: string) {
    return this.service.cancel(id, userId);
  }

  @Post(':id/transfer')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Record the transfer the office raised for this request',
    description:
      'Called after posting a TRANSFER voucher from an approved request. Closes the request, ' +
      'so the salesman cannot then raise a second transfer for the same lines.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Received request, with transferVoucherNumber set' })
  attachTransfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachTransferDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.attachTransfer(id, dto.voucherNumber, user);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Hide a decided request',
    description:
      'Soft delete — the row is kept for history and disappears from the queue. Refused only ' +
      'for pending requests (reject them instead, so the salesman gets a reason) and for any ' +
      'request that stock has already moved against.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: '{ id }' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.softDelete(id, user);
  }

  @Post(':id/receive')
  @ApiOperation({
    summary: 'Confirm the goods are on the van',
    description:
      'Raises the TRANSFER voucher (source → van) that actually moves the stock, and which the ' +
      'outbox pushes to the ERP. Only the requester can confirm.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Received request, with transferVoucherNumber set' })
  receive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.markReceived(id, user);
  }
}
