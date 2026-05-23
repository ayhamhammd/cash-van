import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateVendorDto } from './create-vendor.dto';

export class UpdateVendorDto extends PartialType(
  OmitType(CreateVendorDto, ['vendorNumber'] as const),
) {}
