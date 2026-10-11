import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';
import { ContainersController } from './containers.controller';
import { ContainersService } from './containers.service';

/**
 * Returnable containers — the read side.
 *
 * The write side is VouchersModule: containers move by posting a CONTAINER_IN /
 * CONTAINER_OUT voucher, so the permission and the container-only line check
 * have exactly one home.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [ContainersController],
  providers: [ContainersService],
  exports: [ContainersService],
})
export class ContainersModule {}
