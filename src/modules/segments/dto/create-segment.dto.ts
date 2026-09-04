import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { SegmentKind } from '../entities/customer-segment.entity';

export class CreateSegmentDto {
  @ApiProperty({ description: 'Arabic name (primary)' })
  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @ApiPropertyOptional({ description: 'English name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Chip colour (hex)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional({ enum: ['STATIC', 'DYNAMIC'], default: 'STATIC' })
  @IsOptional()
  @IsIn(['STATIC', 'DYNAMIC'])
  kind?: SegmentKind;

  @ApiPropertyOptional({ description: 'DYNAMIC only — auto-membership criteria' })
  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
