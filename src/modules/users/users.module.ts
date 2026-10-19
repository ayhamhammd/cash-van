import { Module } from '@nestjs/common';

import { User } from './entities/user.entity';
import { UserRepScope } from './entities/user-rep-scope.entity';
import { RepScopeService } from './rep-scope.service';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([User, UserRepScope])],
  controllers: [UsersController],
  providers: [UsersService, RepScopeService],
  exports: [UsersService, RepScopeService, TenantOrmModule],
})
export class UsersModule {}
