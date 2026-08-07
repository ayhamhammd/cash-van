import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './entities/user.entity';
import { UserRepScope } from './entities/user-rep-scope.entity';
import { RepScopeService } from './rep-scope.service';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserRepScope])],
  controllers: [UsersController],
  providers: [UsersService, RepScopeService],
  exports: [UsersService, RepScopeService, TypeOrmModule],
})
export class UsersModule {}
