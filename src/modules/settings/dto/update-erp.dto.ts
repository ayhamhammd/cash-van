import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/** Configure the ERP (erp-saas) connection + the work-with-ERP toggle. */
export class UpdateErpDto {
  @ApiProperty({ description: 'Work WITH the ERP (sync items/units/stores/stock) or standalone' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description: 'ERP origin, e.g. https://erp.example.com (the /api/v1 base is appended)',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(512)
  baseUrl?: string;

  @ApiPropertyOptional({
    description: 'ERP API key (erp_…); encrypted before storage. Omit to keep the current key.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;

  @ApiPropertyOptional({
    description: 'Cash-van store the ERP van warehouse maps to (e.g. "VAN-01"), for stock sync.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vanStore?: string;

  @ApiPropertyOptional({ description: 'ERP category id used when mirroring a new item to the ERP.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  defaultCategoryId?: string;

  @ApiPropertyOptional({ description: 'ERP tax-rate id used when mirroring a new item to the ERP.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  defaultTaxRateId?: string;

  @ApiPropertyOptional({
    description:
      'Auto-push posted vouchers + confirmed collections to the ERP. When false, they wait for manual export.',
  })
  @IsOptional()
  @IsBoolean()
  directExport?: boolean;
}
