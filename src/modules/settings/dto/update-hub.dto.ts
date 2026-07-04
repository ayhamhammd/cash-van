import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Configure the ERP Integration Hub connection (admin only). */
export class UpdateHubDto {
  @ApiProperty({ description: 'Push documents to the ERP THROUGH the Integration Hub.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ description: 'Hub origin, e.g. https://hub.example.com' })
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(512)
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Partner UUID provisioned by the Hub.' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ description: 'Sync bearer secret (VAN_SALES). Encrypted; omit to keep current.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  syncSecret?: string;

  @ApiPropertyOptional({ description: 'Inbound webhook verify secret. Encrypted; omit to keep current.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  webhookSecret?: string;
}
