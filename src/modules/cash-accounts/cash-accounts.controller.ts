import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CashAccountsService } from './cash-accounts.service';
import { CreateCashAccountDto } from './dto/create-cash-account.dto';
import { UpdateCashAccountDto } from './dto/update-cash-account.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('cash-accounts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin', 'manager')
@Controller({ path: 'cash-accounts', version: '1' })
export class CashAccountsController {
  constructor(private readonly service: CashAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List cash accounts (boxes) with derived balances' })
  @ApiOkResponse({ description: 'Accounts + balanceFils' })
  list() {
    return this.service.list();
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create a cash account / box' })
  create(@Body() dto: CreateCashAccountDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a cash account (name / ERP link / active)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCashAccountDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete an empty cash account' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'Ledger of one account (date range + kind filter)' })
  transactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
  ) {
    return this.service.transactions(id, { from, to, kind });
  }

  @Get('rep/:repId/summary')
  @ApiOperation({ summary: "A rep's three boxes + balances (settle dialog / EOD tab)" })
  repSummary(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.service.repSummary(repId);
  }
}
