import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StockCardQueryDto } from './dto/stock-ledger.dto';
import { StockLedgerService } from './stock-ledger.service';

@ApiTags('stock')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'stock', version: '1' })
export class StockLedgerController {
  constructor(private readonly ledger: StockLedgerService) {}

  @Get('movements')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Stock card',
    description:
      'Every movement of one pool in one store, newest first, with the balance after each. ' +
      'Store stock is not rep-scoped, like the stock balances report it opens from.',
  })
  @ApiOkResponse({ description: '{ balanceMilli, rows, nextBeforeSeq }' })
  card(@Query() q: StockCardQueryDto) {
    return this.ledger.card(q);
  }

  @Get('negative')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Pools below zero',
    description:
      'Every pool sitting below zero, by store, with the quantity and what it is worth. ' +
      'A van permitted to go negative will, and a negative nobody is shown is how drift ' +
      'becomes invisible again — which is the whole reason the permission reports itself.',
  })
  @ApiOkResponse({ description: '{ checkedAt, pools, totalValueFils }' })
  negative() {
    return this.ledger.negativePools();
  }

  @Get('ledger/verify')
  @Roles('admin')
  @ApiOperation({
    summary: 'Verify the stock ledger',
    description:
      'Pools where the stored balance differs from a replay of every posted voucher. ' +
      'Empty unless something wrote vouchers around the triggers. Slow — replays all history.',
  })
  @ApiOkResponse({ description: '{ checkedAt, differences }' })
  verify() {
    return this.ledger.verify();
  }
}
