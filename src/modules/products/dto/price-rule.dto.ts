import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreatePriceRuleDto {
  @ApiPropertyOptional({ description: 'Product UUID; null = all products' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'RFM segment; null = all segments' })
  @IsOptional()
  @IsString()
  customerSegment?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPct?: number;

  @ApiPropertyOptional({ description: 'Fixed price in fils; overrides discountPct', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  fixedPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  validTo?: string;
}

export class UpdatePriceRuleDto extends PartialType(CreatePriceRuleDto) {}

export class QuotePriceDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiPropertyOptional({ description: 'Customer UUID; segment is resolved from their AI profile' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
