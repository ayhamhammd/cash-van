import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

const TAX_BASES = ['SALE_PRICE', 'CONSUMER_PRICE'] as const;
const SPECIAL_CALC = ['NONE', 'FIXED_PER_UNIT', 'RATE', 'FIXED_PLUS_RATE'] as const;
const SPECIAL_BASE = ['SALE_PRICE', 'CONSUMER_PRICE', 'QUANTITY'] as const;
const WITHHELD_CALC = ['NONE', 'FIXED_PER_UNIT', 'RATE'] as const;
const WITHHELD_BASE = ['SALE_PRICE', 'CONSUMER_PRICE', 'GROSS_TAX'] as const;

/**
 * Create a tobacco tax profile (standalone mode only — ERP-managed profiles are
 * synced read-only). Money fields (fixed amounts) are integer **fils** per unit,
 * matching FlowVan's internal money convention. Mirrors the ERP zod schema.
 */
export class CreateTobaccoTaxProfileDto {
  @ApiProperty({ example: 'Cigarettes — Standard' })
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiProperty({ enum: TAX_BASES, default: 'CONSUMER_PRICE' })
  @IsIn(TAX_BASES)
  taxBase!: (typeof TAX_BASES)[number];

  // ── Sales tax ──────────────────────────────────────────────────────────────
  @ApiProperty()
  @IsBoolean()
  salesTaxEnabled!: boolean;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  salesTaxRate!: number;

  // ── Special / excise tax ────────────────────────────────────────────────────
  @ApiProperty()
  @IsBoolean()
  specialTaxEnabled!: boolean;

  @ApiProperty({ enum: SPECIAL_CALC })
  @IsIn(SPECIAL_CALC)
  specialTaxCalculationType!: (typeof SPECIAL_CALC)[number];

  @ApiProperty({ enum: SPECIAL_BASE })
  @IsIn(SPECIAL_BASE)
  specialTaxBase!: (typeof SPECIAL_BASE)[number];

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  specialTaxRate?: number | null;

  @ApiPropertyOptional({ minimum: 0, description: 'Integer fils per unit.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  specialTaxFixedAmount?: number | null;

  // ── Withheld / prepaid tax ──────────────────────────────────────────────────
  @ApiProperty()
  @IsBoolean()
  withheldTaxEnabled!: boolean;

  @ApiProperty({ enum: WITHHELD_CALC })
  @IsIn(WITHHELD_CALC)
  withheldTaxCalculationType!: (typeof WITHHELD_CALC)[number];

  @ApiProperty({ enum: WITHHELD_BASE })
  @IsIn(WITHHELD_BASE)
  withheldTaxBase!: (typeof WITHHELD_BASE)[number];

  @ApiPropertyOptional({ minimum: 0, description: 'Integer fils per unit.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  withheldTaxAmount?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  withheldTaxRate?: number | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  taxIncludedInConsumerPrice?: boolean;

  @ApiPropertyOptional({ example: '2025-01-01' })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTobaccoTaxProfileDto extends PartialType(CreateTobaccoTaxProfileDto) {}
