import { GUARDS_METADATA } from '@nestjs/common/constants';

import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

describe('program features stay editable while the ERP is on', () => {
  it('saves through an endpoint the ERP read-only guard does not cover', () => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, SettingsController.prototype.updateProgramFeatures) ?? [];
    expect(guards).not.toContain(ErpReadOnlyGuard);
  });

  it('writes the target switches and nothing the ERP owns', async () => {
    const row = {
      id: 1,
      companyNameAr: 'شركة',
      targetsIncludeTax: true,
      targetsSalesIncludeCash: true,
      damagedReturnsEnabled: false,
    } as Record<string, unknown>;
    const saved: Record<string, unknown>[] = [];
    const svc = Object.create(SettingsService.prototype) as Record<string, unknown>;
    svc.repo = {
      findOne: async () => row,
      save: async (r: Record<string, unknown>) => saved.push({ ...r }),
    };
    svc.userCtx = { getUserId: () => 'u1' };
    svc.toView = (r: unknown) => r;

    await (svc as unknown as SettingsService).updateProgramFeatures({
      targetsIncludeTax: false,
      targetsSalesIncludeCash: false,
      companyNameAr: 'غيرها',
    } as never);

    expect(saved[0]).toMatchObject({
      targetsIncludeTax: false,
      targetsSalesIncludeCash: false,
      damagedReturnsEnabled: false,
      companyNameAr: 'شركة',
    });
  });
});
