import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

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

  /*
   * An EXPLICIT range, alongside the rolling `days` window.
   *
   * `days` answers the dashboard's question ("last 30 days"). It cannot answer the
   * handset's: a rep searching a report picks two dates, and "the first week of
   * last month" is not a lookback. Where both arrive the explicit range wins, as
   * the more specific request.
   */
  @ApiPropertyOptional({ description: 'Inclusive start date (YYYY-MM-DD). Takes precedence over `days`.' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Inclusive end date (YYYY-MM-DD). Takes precedence over `days`.' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /**
   * best-items only: one row per (item, unit) instead of per item.
   *
   * Opt-in so the dashboard's ranked widget keeps the rows it has. The handset's
   * report needs the split — an item sells in several units, and an offer gives a
   * piece free against a carton sold.
   */
  @ApiPropertyOptional({ description: 'best-items: group by item AND unit (default false).' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  byUnit?: boolean;
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
