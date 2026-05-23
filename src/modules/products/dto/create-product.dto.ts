import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { TaxCategory, TaxType } from '../../items/entities/item-cart.entity';

const TAX_TYPES: TaxType[] = ['TAXABLE', 'INCLUSIVE', 'EXEMPT'];
const TAX_CATS: TaxCategory[] = ['S', 'Z', 'E'];

export class CreateProductDto {
  @ApiProperty({ description: 'Legacy item number (unique)' })
  @IsString()
  @Length(1, 64)
  itemNumber!: string;

  @ApiProperty({ description: 'Stock-keeping unit (unique); defaults to itemNumber' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  sku?: string;

  @ApiProperty()
  @IsString()
  @Length(1, 64)
  barcode!: string;

  @ApiProperty({ description: 'Display name (legacy)' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ description: 'Arabic name; defaults to name' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ default: 'carton' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  unit?: string;

  @ApiPropertyOptional({ default: 'PCE', description: 'UN/CEFACT unit code for JoFotara' })
  @IsOptional()
  @IsString()
  @Length(1, 16)
  unitOfMeasure?: string;

  @ApiProperty({ description: 'Sale price in fils (1 JOD = 1000 fils)', minimum: 0 })
  @IsInt()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({ description: 'Cost in fils', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  cost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  reorderQty?: number;

  @ApiPropertyOptional({ enum: TAX_TYPES, default: 'TAXABLE' })
  @IsOptional()
  @IsIn(TAX_TYPES)
  taxType?: TaxType;

  @ApiPropertyOptional({ enum: TAX_CATS, default: 'S' })
  @IsOptional()
  @IsIn(TAX_CATS)
  taxCategory?: TaxCategory;

  @ApiPropertyOptional({ default: 0.16, minimum: 0, maximum: 1, description: 'Decimal rate, e.g. 0.16' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  taxRate?: number;
}
