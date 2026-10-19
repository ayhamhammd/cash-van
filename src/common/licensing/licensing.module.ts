import { Global, Module } from '@nestjs/common';

import { LicenseContext } from './license-context.service';
import { LicenseService } from './license.service';

@Global()
@Module({
  providers: [LicenseService, LicenseContext],
  exports: [LicenseService, LicenseContext],
})
export class LicensingModule {}
