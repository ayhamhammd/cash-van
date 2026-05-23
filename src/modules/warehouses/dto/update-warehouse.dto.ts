import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateWarehouseDto } from './create-warehouse.dto';

export class UpdateWarehouseDto extends PartialType(
  OmitType(CreateWarehouseDto, ['whNumber'] as const),
) {}
