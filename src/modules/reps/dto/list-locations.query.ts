import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListLocationsQuery {
  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now() - 24h' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now()' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1000, minimum: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number = 1000;

  @ApiPropertyOptional({
    description:
      'Downsample the trail to at most this many points (evenly, keeping first + last). Use for wide ranges (e.g. a month) so the map gets a light path. Overrides `limit` when set.',
    minimum: 2,
    maximum: 10000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(10000)
  maxPoints?: number;
}
