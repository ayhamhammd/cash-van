import { PickType } from '@nestjs/swagger';

import { UpdateAppSettingsDto } from './update-settings.dto';

export class UpdateProgramFeaturesDto extends PickType(UpdateAppSettingsDto, [
  'damagedReturnsEnabled',
  'damagedWarehouseCode',
  'containersEnabled',
  'targetsIncludeTax',
  'targetsSalesIncludeCash',
] as const) {}
