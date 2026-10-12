import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { RolesGuard } from '../../common/guards/roles.guard';
import { UserContextService } from '../../common/context/user-context.service';
import { User } from '../users/entities/user.entity';
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
 * a salesman is PINNED to their own customers — see [ownScope]. One rep being
 * able to list another rep's outstanding packaging is not a leak worth having
 * for a figure nobody needs across rounds.
 */
@ApiTags('containers')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'containers', version: '1' })
export class ContainersController {
  constructor(
    private readonly containers: ContainersService,
    private readonly userCtx: UserContextService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * The caller's own user code when they are a salesman, else whatever they
   * asked for.
   *
   * `admin` / `manager` / `supervisor` see the whole company; anyone else is
   * narrowed to themselves regardless of the `userCode` they sent, because the
   * query parameter is a convenience for the dashboard and not a capability.
   */
  private async ownScope(requested?: string): Promise<string | undefined> {
    const ctx = this.userCtx.get();
    if (!ctx) return requested;
    const role = ctx.role?.toLowerCase();
    if (role === 'admin' || role === 'manager' || role === 'supervisor') return requested;
    const user = await this.users.findOne({
      where: { id: ctx.userId },
      select: { id: true, userNumber: true, userType: true },
    });
    if (!user || user.userType === 'ADMIN') return requested;
    return user.userNumber;
  }

  @Get('balances')
  @ApiOperation({
    summary: 'Outstanding returnable containers, by customer',
    description:
      'One row per (customer, container). `outstanding` is what the customer is ' +
      'still holding: what their sales implied, plus what was lent on a ' +
      'CONTAINER_OUT, minus what came back on a CONTAINER_IN. `daysOutstanding` ' +
      'ages from the oldest movement that put containers out.',
  })
  @ApiOkResponse({ description: 'ContainerBalanceRow[]' })
  async balances(@Query() q: ContainerBalanceQueryDto) {
    return this.containers.balances({ ...q, userCode: await this.ownScope(q.userCode) });
  }

  @Get('totals')
  @ApiOperation({
    summary: 'Outstanding containers per kind',
    description: 'One row per kind of container: how many are out, with how many customers.',
  })
  async totals(@Query('userCode') userCode?: string) {
    return this.containers.totals(await this.ownScope(userCode));
  }

  @Get('customers/:customerNumber')
  @ApiOperation({
    summary: 'What one customer is holding',
    description:
      'The figure the rep needs before knocking. Empty array when they hold nothing.',
  })
  async forCustomer(@Param('customerNumber') customerNumber: string) {
    return this.containers.forCustomer(customerNumber);
  }
}
