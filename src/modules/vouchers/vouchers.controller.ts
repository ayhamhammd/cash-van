import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { VouchersService } from './vouchers.service';
import { TransactionKindsService } from './transaction-kinds.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { ListVouchersQueryDto } from './dto/list-vouchers-query.dto';
import { PreviewVoucherNumberQueryDto } from './dto/preview-number.query';
import { CreateChequeDto } from './dto/create-cheque.dto';
import { CreateTransactionKindDto } from './dto/create-transaction-kind.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { RepScopeService } from '../users/rep-scope.service';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('vouchers')
@ApiBearerAuth()
@Controller({ path: 'vouchers', version: '1' })
export class VouchersController {
  constructor(
    private readonly vouchersService: VouchersService,
    private readonly transactionKindsService: TransactionKindsService,
    private readonly repScope: RepScopeService,
  ) {}

  // ---- Transaction kinds (lookup) -------------------------------------------
  @Get('kinds')
  @ApiOperation({ summary: 'List transaction kinds', description: 'List voucher transaction-kind lookups.' })
  @ApiOkResponse({ description: 'Transaction kinds' })
  listKinds() {
    return this.transactionKindsService.list();
  }

  @Post('kinds')
  @ApiOperation({
    summary: 'Create transaction kind',
    description: 'Create a transaction kind (e.g. SALE, PURCHASE).',
  })
  @ApiCreatedResponse({ description: 'Transaction kind created' })
  createKind(@Body() dto: CreateTransactionKindDto) {
    return this.transactionKindsService.create(dto);
  }

  // ---- Vouchers --------------------------------------------------------------
  @Get('next-number')
  @ApiOperation({
    summary: 'Preview next voucher number',
    description:
      'Returns the serial number the next voucher of this kind/store will get, without consuming the sequence.',
  })
  @ApiOkResponse({ description: 'The next voucher number' })
  previewNumber(@Query() query: PreviewVoucherNumberQueryDto) {
    return this.vouchersService.previewVoucherNumber(query.transKind, query.store);
  }

  @Post()
  @ApiOperation({
    summary: 'Create voucher',
    description:
      'Create a voucher (header + lines + payments) atomically. SALE requires ' +
      'canCreateSale, RETURN requires canCreateReturn; every other kind (ORDER, ' +
      'TRANSFER, …) requires canMakeVoucher.',
  })
  @ApiCreatedResponse({ description: 'Voucher created' })
  create(
    @Body() dto: CreateVoucherDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Per-kind gate. Can't sit in a @RequirePermissions decorator because the
    // required permission depends on the request body (transKind); admins bypass
    // exactly as the global PermissionsGuard does.
    if (user.userType !== 'ADMIN') {
      const kind = (dto.transKind ?? '').toUpperCase();
      const needed =
        kind === 'SALE'
          ? 'canCreateSale'
          : kind === 'RETURN'
            ? 'canCreateReturn'
            : 'canMakeVoucher';
      if (!user.permissions?.[needed]) {
        throw new ForbiddenException(`Missing permission: ${needed}`);
      }
    }
    return this.vouchersService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List vouchers',
    description:
      'List vouchers, optionally filtered by transKind, userCode, store and date range.',
  })
  @ApiOkResponse({ description: 'Voucher list' })
  async list(
    @Query() query: ListVouchersQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vouchersService.list(query, await this.repScope.visibleRepIds(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get voucher', description: 'Fetch a single voucher by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Voucher id' })
  @ApiOkResponse({ description: 'The voucher' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.vouchersService.findOneOrThrow(id);
  }

  @Patch(':id')
  @RequirePermissions('canEditVoucher')
  @ApiOperation({
    summary: 'Update voucher',
    description: 'Edit an unposted voucher header. Requires canEditVoucher.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Voucher id' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        totalDiscountValue: { type: 'string', example: '1500', description: 'Discount amount in fils' },
        totalDiscountPercentage: { type: 'string', example: '5' },
        customerNumber: { type: 'string', example: 'C-1001' },
        vendorNumber: { type: 'string', example: 'V-2001' },
      },
    },
  })
  @ApiOkResponse({ description: 'Updated voucher header' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() patch: Partial<{
      totalDiscountValue: string;
      totalDiscountPercentage: string;
      customerNumber: string;
      vendorNumber: string;
    }>,
  ) {
    return this.vouchersService.update(id, patch);
  }

  @Patch(':id/post')
  @RequirePermissions('canMakeVoucher')
  @ApiOperation({
    summary: 'Post voucher',
    description: 'Post a voucher: makes it immutable and applies its effect on stock balance. Requires canMakeVoucher.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Voucher id' })
  @ApiOkResponse({ description: 'Posted voucher' })
  post(@Param('id', ParseUUIDPipe) id: string) {
    return this.vouchersService.post(id);
  }

  @Patch(':id/fulfill')
  @RequirePermissions('canMakeVoucher')
  @ApiOperation({
    summary: 'Fulfil order',
    description:
      'Fulfil a posted ORDER voucher: releases its van reservation and ships the goods (reserved → out). Requires canMakeVoucher.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Voucher id' })
  @ApiOkResponse({ description: 'Fulfilled order voucher' })
  fulfill(@Param('id', ParseUUIDPipe) id: string) {
    return this.vouchersService.fulfill(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete voucher', description: 'Delete an unposted voucher.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Voucher id' })
  @ApiNoContentResponse({ description: 'Voucher deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.vouchersService.remove(id);
  }

  // ---- Cheques ---------------------------------------------------------------
  @Post('cheques')
  @ApiOperation({ summary: 'Create cheque', description: 'Create a cheque record attached to vouchers.' })
  @ApiCreatedResponse({ description: 'Cheque created' })
  createCheque(@Body() dto: CreateChequeDto) {
    return this.vouchersService.createCheque(dto);
  }

  @Get('cheques/list')
  @ApiOperation({ summary: 'List cheques', description: 'List voucher cheques.' })
  @ApiOkResponse({ description: 'Cheque list' })
  listCheques() {
    return this.vouchersService.listCheques();
  }

  @Delete('cheques/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete cheque', description: 'Delete a voucher cheque.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Cheque id' })
  @ApiNoContentResponse({ description: 'Cheque deleted' })
  removeCheque(@Param('id', ParseUUIDPipe) id: string) {
    return this.vouchersService.removeCheque(id);
  }
}
