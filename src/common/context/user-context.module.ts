import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';

import { UserContextService } from './user-context.service';

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
  ],
  providers: [UserContextService],
  exports: [UserContextService, ClsModule],
})
export class UserContextModule {}
