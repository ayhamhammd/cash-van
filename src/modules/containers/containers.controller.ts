import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RepScopeService } from '../users/rep-scope.service';
import { ContainersService } from './containers.service';
import { ContainerBalanceQueryDto } from './dto/container-balance.query';

/**
 * What customers are still holding in returnable packaging.
 *
 * Read-only. Containers MOVE by posting a CONTAINER_IN / CONTAINER_OUT voucher,
 * which is where the permission and the container-only line check live; there is
 * deliberately no write endpoint here to go around them.
 *
 * Open to any authenticated user, like the other screens the handset reads, but
 * every endpoint is rep-scoped through `RepScopeService` — the same service the
 * reports use, so a supervisor who may see four salesmen sees those four here
 * too. See docs/SPEC-rep-scoped-users.md.
 */
@ApiTags('containers')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'containers', version: '1' })
export class ContainersController {
  constructor(
    private readonly containers: ContainersService,
    private readonly repScope: RepScopeService,
  ) {}

  @Get('balances')
  @ApiOperation({
    summary: 'Outstanding returnable containers, by customer',
    description:
      'One row per (customer, container). `outstanding` is what the customer is ' +
      'still holding: what their sales implied, plus what was lent on a ' +
      'CONTAINER_OUT, minus what came back on a CONTAINER_IN. `daysOutstanding` ' +
      'ages from the oldest movement that put containers out. Rep-scoped: a ' +
      'salesman sees their own customers, a scoped supervisor sees theirs. The ' +
      '`userCode` parameter narrows that further and cannot widen it.',
  })
  @ApiOkResponse({ description: 'ContainerBalanceRow[]' })
  async balances(
    @Query() q: ContainerBalanceQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.containers.balances({
      ...q,
      visibleRepIds: await this.repScope.visibleRepIds(user),
    });
  }

  @Get('totals')
  @ApiOperation({
    summary: 'Outstanding containers per kind',
    description:
      'One row per kind of container: how many are out, with how many customers. ' +
      'Rep-scoped exactly as `balances` is, so the totals match the list beneath them.',
  })
  async totals(
    @CurrentUser() user: AuthenticatedUser,
    @Query('userCode') userCode?: string,
  ) {
    return this.containers.totals({
      userCode,
      visibleRepIds: await this.repScope.visibleRepIds(user),
    });
  }

  @Get('customers/:customerNumber')
  @ApiOperation({
    summary: 'What one customer is holding',
    description:
      'The figure the rep needs before knocking. Empty array when they hold ' +
      'nothing — or when the customer is outside the caller’s rep scope, which ' +
      'reads the same way the balances list does for a customer that is not theirs.',
  })
  async forCustomer(
    @Param('customerNumber') customerNumber: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Scoped like the list it zooms into. Naming a customer directly must not
    // reach a salesman the caller cannot see — the mistake the reports made
    // once already (see reports.controller.ts salesmanDocuments).
    return this.containers.forCustomer(
      customerNumber,
      await this.repScope.visibleRepIds(user),
    );
  }
}
