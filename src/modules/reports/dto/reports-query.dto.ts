import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Offset pagination for report endpoints. */
export class ReportsQueryDto {
  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, description: 'Optional lookback window in days (including today). Omit for all-time.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

/** Lookback window + row cap for ranked/trend report endpoints. */
export class ReportsRangeQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30, description: 'Lookback window in days (including today)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Day (and optional rep) for the GPS trips report. */
export class TripsQueryDto {
  @ApiProperty({ example: '2026-06-11', description: 'Calendar day to segment (YYYY-MM-DD).' })
  @IsDateString()
  date!: string;

  @ApiPropertyOptional({ description: 'Restrict to a single rep id. Omit for the whole fleet.' })
  @IsOptional()
  @IsUUID()
  repId?: string;
}
