import { Global, Module } from '@nestjs/common';

import { AppSettings } from './entities/app-settings.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { CompanyInfoController } from './company-info.controller';
import { VoucherTemplateController } from './voucher-template.controller';
import { VoucherReportController } from './voucher-report.controller';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

/** Global so SettingsService (+ the ERP read-only guard) is injectable app-wide. */
@Global()
@Module({
  imports: [TenantOrmModule.forFeature([AppSettings])],
  controllers: [
    SettingsController,
    CompanyInfoController,
    VoucherTemplateController,
    VoucherReportController,
  ],
  providers: [SettingsService, ErpReadOnlyGuard],
  exports: [SettingsService, ErpReadOnlyGuard],
})
export class SettingsModule {}
