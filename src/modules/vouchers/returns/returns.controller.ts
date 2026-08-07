import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ReturnCandidatesService } from './candidates';
import { ReturnCreateService } from './create';
import { allocateReturn, compareStrategies } from './allocate';
import { RETURN_STRATEGIES, STRATEGY_RATIONALE } from './strategies';
import { ConfirmReturnDto, PreviewReturnDto } from './dto/return-allocation.dto';

/**
 * Return by item — returning goods without naming the sale they came from.
 *
 * See docs/RETURNS-without-a-sale-voucher.md. Two calls on purpose: one item can
 * span several sales and different items can come from different sales, so the
 * number of documents a confirm will create is not knowable from the request.
 * The user has to see the match before it exists.
 */
@ApiTags('vouchers-returns')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'vouchers/returns', version: '1' })
export class ReturnsController {
  constructor(
    private readonly candidates: ReturnCandidatesService,
    private readonly creator: ReturnCreateService,
  ) {}

  @Post('preview')
  @Roles('admin', 'manager', 'supervisor')
  @ApiOperation({
    summary: 'Preview a return by item',
    description:
      "Matches each item to that item's past sales, walked in the chosen order, and returns the plan WITHOUT creating anything. Also returns what every other strategy would have done, so 'why that voucher?' is answerable on screen.",
  })
  @ApiOkResponse({ description: '{ plan, alternatives }' })
  async preview(@Body() dto: PreviewReturnDto) {
    const strategy = dto.strategy ?? 'NEWEST_FIRST';
    const request = dto.lines.map((l) => ({
      itemNumber: l.itemNumber,
      itemUnitId: l.itemUnitId ?? null,
      quantity: l.quantity,
      expectedUnitPrice: l.expectedUnitPrice,
    }));

    const candidates = await this.candidates.find({
      itemNumbers: [...new Set(dto.lines.map((l) => l.itemNumber))],
      customerNumber: dto.customerNumber ?? null,
      userCode: dto.userCode ?? null,
    });

    return {
      plan: allocateReturn({ request, candidates, strategy }),
      // Every strategy over the same input, so the alternatives are comparable
      // rather than merely described.
      alternatives: compareStrategies({
        request,
        candidates,
        strategies: RETURN_STRATEGIES.filter((s) => s !== strategy),
      }),
      rationale: STRATEGY_RATIONALE,
    };
  }

  @Post('confirm')
  @Roles('admin', 'manager', 'supervisor')
  @ApiOperation({
    summary: 'Create the return vouchers',
    description:
      'Re-runs the allocation server-side, re-checks every source line under a row lock, and creates ONE return voucher per source sale. Never trusts a plan sent by the client.',
  })
  @ApiCreatedResponse({ description: '{ vouchers: string[] }' })
  async confirm(@Body() dto: ConfirmReturnDto) {
    const strategy = dto.strategy ?? 'NEWEST_FIRST';
    const request = dto.lines.map((l) => ({
      itemNumber: l.itemNumber,
      itemUnitId: l.itemUnitId ?? null,
      quantity: l.quantity,
      expectedUnitPrice: l.expectedUnitPrice,
    }));

    // Re-read and re-allocate rather than accepting the previewed plan: a plan
    // from the client is a request to create documents against sale lines of its
    // choosing, at prices of its choosing.
    const candidates = await this.candidates.find({
      itemNumbers: [...new Set(dto.lines.map((l) => l.itemNumber))],
      customerNumber: dto.customerNumber ?? null,
      userCode: dto.userCode ?? null,
    });
    const plan = allocateReturn({ request, candidates, strategy });

    return this.creator.createFromPlan({
      plan,
      userCode: dto.confirmUserCode,
      customerNumber: dto.customerNumber ?? null,
      storeNumber: dto.storeNumber ?? null,
      post: dto.post ?? false,
    });
  }
}
