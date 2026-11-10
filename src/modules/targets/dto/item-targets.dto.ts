import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ItemTargetLineDto {
  @ApiProperty({ description: 'The CashVan item number (SKU).' })
  @IsString()
  @Length(1, 100)
  itemNumber!: string;

  @ApiProperty({ enum: ['QTY', 'AMOUNT'] })
  @IsIn(['QTY', 'AMOUNT'])
  metric!: 'QTY' | 'AMOUNT';

  @ApiPropertyOptional({ description: 'QTY: base units, > 0, at most 3 decimals.' })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  targetQty?: number;

  @ApiPropertyOptional({ description: 'AMOUNT: fils, a whole number > 0.' })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  targetFils?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** PUT /targets/items — replaces one rep's item targets for a month. */
export class PutItemTargetsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  repId!: string;

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 11 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty({ type: [ItemTargetLineDto], description: 'The full set: items left out are deleted.' })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItemTargetLineDto)
  lines!: ItemTargetLineDto[];
}
