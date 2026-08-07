import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
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

  @ApiPropertyOptional({
    default: false,
    description:
      'True makes this unit a VARIANT — a physically different good (أحمر) that ' +
      'owns its own stock pool. False (the default) is a packaging unit ' +
      '(كرتونة ×12): a way to enter a quantity of the same goods, drawing from ' +
      "the item's base pool.",
  })
  @IsOptional()
  @IsBoolean()
  isStockUnit?: boolean;

  @ApiPropertyOptional({
    example: 'SKU-1001-RED',
    description:
      'The ERP product_skus.sku this unit mirrors, so an outbound sale posts ' +
      'against the variant instead of the base SKU. Normally written by sync.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  erpSkuCode?: string;
}

export class UpdateItemUnitDto extends PartialType(CreateItemUnitDto) {
  @ApiPropertyOptional({ description: 'Changing the unit is not supported — detach + reattach' })
  declare unitId?: string;
}
