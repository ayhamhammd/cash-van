import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Rep } from '../reps/entities/rep.entity';
import { SupervisorRep } from './entities/supervisor-rep.entity';
import { User } from './entities/user.entity';
import { SupervisorRepsController } from './supervisor-reps.controller';
import { SupervisorRepsService } from './supervisor-reps.service';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, SupervisorRep, Rep])],
  controllers: [UsersController, SupervisorRepsController],
  providers: [UsersService, SupervisorRepsService],
  exports: [UsersService, SupervisorRepsService, TypeOrmModule],
})
export class UsersModule {}
