import { Controller, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PaymentFilsRepairService } from './payment-fils-repair.service';

@ApiTags('vouchers')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'vouchers/payments', version: '1' })
export class PaymentFilsRepairController {
  constructor(private readonly repair: PaymentFilsRepairService) {}

  @Post('repair-fils')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Put back the third decimal payments lost while payments.amount was numeric(14,2)',
    description:
      'Admin only, never automatic. Touches only a voucher with ONE payment whose amount equals ' +
      'ROUND(net_total, 2): it gets the exact net_total. Multi-payment and other mismatches are ' +
      'counted and left alone. ?dryRun=true reports without writing. Safe to run again.',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiOkResponse({ description: '{ dryRun, repaired, sample, leftAlone: { multiPayment, singleNotRounding } }' })
  run(@Query('dryRun') dryRun?: string) {
    return this.repair.repair({ dryRun: dryRun === 'true' || dryRun === '1' });
  }
}
