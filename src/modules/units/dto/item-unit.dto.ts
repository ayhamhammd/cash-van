import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Attach a unit to an item with the per-item barcode + sale price.
 * The conversion factor (base_qty) lives on the unit master.
 */
export class CreateItemUnitDto {
  @ApiProperty({ format: 'uuid', description: 'Unit from the catalog' })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ example: '4423524', description: 'Per-unit barcode (unique across all item-units)' })
  @IsString()
  @MaxLength(64)
  barcode!: string;

  @ApiProperty({ example: '8.400', description: 'Per-unit sale price in JOD (3-dp string)' })
  @IsNumberString()
  @MaxLength(20)
  salePrice!: string;

  @ApiPropertyOptional({
    example: 6,
    minimum: 1,
    description:
      'Pieces this unit represents for this item. Defaults to the unit master baseQty when omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;
}

export class UpdateItemUnitDto extends PartialType(CreateItemUnitDto) {
  @ApiPropertyOptional({ description: 'Changing the unit is not supported — detach + reattach' })
  declare unitId?: string;
}
