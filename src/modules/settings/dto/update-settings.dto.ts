import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { TaxCalcMethod } from '../entities/app-settings.entity';

const TAX_CALC_METHODS: TaxCalcMethod[] = ['INCLUSIVE', 'EXCLUSIVE'];

export class UpdateAppSettingsDto {
  @ApiPropertyOptional({ example: 'C001', description: 'Single-tenant company id (mobile BFF)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  companyNumber?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/logo.png', description: 'Company logo URL' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'شركة ABC للتجارة' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  companyNameAr?: string;

  @ApiPropertyOptional({ example: 'ABC Trading Co.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  companyNameEn?: string;

  @ApiPropertyOptional({ example: '123456789' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sellerTin?: string;

  @ApiPropertyOptional({ example: 'Amman, Jordan', description: 'Seller address line' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  sellerAddress?: string;

  @ApiPropertyOptional({ example: '+96264000000', description: 'Seller contact phone' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sellerPhone?: string;

  @ApiPropertyOptional({ example: 'JO-AM' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  sellerCityCode?: string;

  @ApiPropertyOptional({
    enum: TAX_CALC_METHODS,
    example: 'EXCLUSIVE',
    description:
      'Whether unit prices already include tax (INCLUSIVE) or tax is added on top (EXCLUSIVE).',
  })
  @IsOptional()
  @IsIn(TAX_CALC_METHODS)
  taxCalcMethod?: TaxCalcMethod;

  @ApiPropertyOptional({ example: 'Asia/Amman' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: 'ar' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  locale?: string;

  @ApiPropertyOptional({ minimum: 0, example: 500, description: 'Monthly AI chat message quota' })
  @IsOptional()
  @IsInt()
  @Min(0)
  aiChatQuota?: number;

  @ApiPropertyOptional({ minimum: 0, example: 2000, description: 'Monthly AI inference quota' })
  @IsOptional()
  @IsInt()
  @Min(0)
  aiInferQuota?: number;
}
