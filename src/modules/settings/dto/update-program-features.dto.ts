import { PickType } from '@nestjs/swagger';

import { UpdateAppSettingsDto } from './update-settings.dto';

export class UpdateProgramFeaturesDto extends PickType(UpdateAppSettingsDto, [
  'damagedReturnsEnabled',
  'damagedWarehouseCode',
  'containersEnabled',
  'deliveryIncreaseRequests',
  'deliveryProofRequired',
  'targetsIncludeTax',
  'targetsSalesIncludeCash',
] as const) {}
