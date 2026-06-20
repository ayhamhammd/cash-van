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
}
