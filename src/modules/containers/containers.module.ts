import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module';
import { ContainersController } from './containers.controller';
import { ContainersService } from './containers.service';

/**
 * Returnable containers — the read side.
 *
 * The write side is VouchersModule: containers move by posting a CONTAINER_IN /
 * CONTAINER_OUT voucher, so the permission and the container-only line check
 * have exactly one home.
 *
 * UsersModule for `RepScopeService`, which answers "whose customers may this
 * caller see?" for the whole dashboard — asked here rather than answered again.
 */
@Module({
  imports: [UsersModule],
  controllers: [ContainersController],
  providers: [ContainersService],
  exports: [ContainersService],
})
export class ContainersModule {}
