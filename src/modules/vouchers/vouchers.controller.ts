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
import { CreateChequeDto } from './dto/create-cheque.dto';
import { CreateTransactionKindDto } from './dto/create-transaction-kind.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@ApiTags('vouchers')
@ApiBearerAuth()
@Controller({ path: 'vouchers', version: '1' })
export class VouchersController {
  constructor(
    private readonly vouchersService: VouchersService,
    private readonly transactionKindsService: TransactionKindsService,
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
  @Post()
  @RequirePermissions('canMakeVoucher')
  @ApiOperation({
    summary: 'Create voucher',
    description: 'Create a voucher (header + lines + payments) atomically. Requires canMakeVoucher.',
  })
  @ApiCreatedResponse({ description: 'Voucher created' })
  create(@Body() dto: CreateVoucherDto) {
    return this.vouchersService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List vouchers', description: 'List all vouchers.' })
  @ApiOkResponse({ description: 'Voucher list' })
  list() {
    return this.vouchersService.list();
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
