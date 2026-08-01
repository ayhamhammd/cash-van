import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class QuoteTemplateItemDto {
  @ApiProperty({ description: 'Catalog item number (snapshot key).' })
  @IsString()
  @IsNotEmpty()
  itemNumber!: string;

  @ApiProperty({ description: 'Display name at the time the template was built.' })
  @IsString()
  @IsNotEmpty()
  nameAr!: string;

  @ApiProperty({ description: 'Outreach price per unit, in fils.' })
  @IsInt()
  @Min(0)
  priceFils!: number;
}

export class CreateQuoteTemplateDto {
  @ApiProperty({ description: 'Template name (internal, shown in the list).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: 'Logo as a data: URL.' })
  @IsOptional()
  @IsString()
  // Matches MAX_LOGO_DATAURL_CHARS on the client, so an oversized logo fails
  // validation with a clear message instead of bloating every quote render.
  @MaxLength(1_000_000, { message: 'logoUrl is too large — use a smaller image' })
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Company description shown on the quote.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string;

  @ApiPropertyOptional({ description: 'Contact phone numbers (quote footer).' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phones?: string[];

  @ApiPropertyOptional({ type: [QuoteTemplateItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteTemplateItemDto)
  items?: QuoteTemplateItemDto[];

  @ApiPropertyOptional({ description: 'Prefilled WhatsApp outreach message.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  whatsappMessageAr?: string;

  @ApiPropertyOptional({ description: 'Inactive → public URL stops resolving.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateQuoteTemplateDto extends PartialType(CreateQuoteTemplateDto) {}
