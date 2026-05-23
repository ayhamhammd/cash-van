import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class CreateVisitDto {
  @ApiProperty({ description: 'Rep who performed the visit' })
  @IsUUID()
  repId!: string;

  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now()' })
  @IsOptional()
  @IsDateString()
  visitedAt?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hadSale?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  visitNote?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  lng?: number;
}
