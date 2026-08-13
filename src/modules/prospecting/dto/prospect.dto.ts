import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  PROSPECT_MAX_CATEGORIES,
  PROSPECT_MAX_KEYWORDS,
  PROSPECT_STATUSES,
} from '../prospecting.types';

export class CreateProspectSearchDto {
  @ApiProperty({ description: 'Search centre latitude.' })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ description: 'Search centre longitude.' })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiProperty({ description: 'Radius in metres (200–20000).' })
  @Type(() => Number)
  @IsInt()
  @Min(200)
  @Max(20_000)
  radiusM!: number;

  @ApiPropertyOptional({
    description:
      'Google Places types, e.g. supermarket, grocery_store. Optional when ' +
      '`keyword` is given; at least one of the two is required.',
    example: ['supermarket', 'grocery_store'],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(PROSPECT_MAX_CATEGORIES)
  @IsString({ each: true })
  categories?: string[];

  @ApiPropertyOptional({
    description:
      "The caller's own terms, matched against the business name inside the " +
      'same circle — for trades the category allow-list does not cover ' +
      '("مكتبة", a brand, a chain). Each term costs one Text Search call. ' +
      'Combines with `categories`; results are merged and de-duplicated by ' +
      'place id.',
    example: ['ماركت', 'مكتبة'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PROSPECT_MAX_KEYWORDS)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];
}

export class UpdateProspectDto {
  @ApiPropertyOptional({ enum: PROSPECT_STATUSES })
  @IsOptional()
  @IsIn(PROSPECT_STATUSES)
  status?: (typeof PROSPECT_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ListProspectsQueryDto {
  @ApiPropertyOptional({ description: 'Only prospects from this search.' })
  @IsOptional()
  @IsUUID()
  searchId?: string;

  @ApiPropertyOptional({ enum: PROSPECT_STATUSES })
  @IsOptional()
  @IsIn(PROSPECT_STATUSES)
  status?: (typeof PROSPECT_STATUSES)[number];

  @ApiPropertyOptional({
    description: 'true = hide prospects already matched to a customer.',
  })
  @IsOptional()
  @IsString()
  newOnly?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ description: 'Name/address search.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ConvertProspectDto {
  @ApiProperty({ description: 'Customer number to create (must be unique).' })
  @IsString()
  @MaxLength(50)
  customerNumber!: string;

  @ApiPropertyOptional({ description: 'Assign to this rep.' })
  @IsOptional()
  @IsUUID()
  repId?: string;
}

export class SendQuoteDto {
  @ApiPropertyOptional({
    description:
      'Quote template to send. Defaults to the first active template. The ' +
      'message body and the public link both come from the template — the ' +
      'caller cannot supply free text, so nothing arbitrary can be sent from ' +
      'the company number.',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;
}

export class GeocodeQueryDto {
  @ApiProperty({ description: 'Free-text place or address, e.g. "خلدا".' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;
}
