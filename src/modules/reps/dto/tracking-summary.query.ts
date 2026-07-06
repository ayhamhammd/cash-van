import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';

export class TrackingSummaryQuery {
  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now() - 30d' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now()' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Group buckets by calendar day or month.',
    enum: ['day', 'month'],
    default: 'day',
  })
  @IsOptional()
  @IsIn(['day', 'month'])
  bucket?: 'day' | 'month';
}
