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
