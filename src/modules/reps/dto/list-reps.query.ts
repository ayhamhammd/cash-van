import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { REP_KINDS, type RepKind } from '../entities/rep.entity';

export class ListRepsQuery {
  @ApiPropertyOptional({ description: 'Filter by region', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ description: 'Filter by active status', example: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: REP_KINDS,
    description: 'Only reps of this kind (SALES | DELIVERY | BOTH).',
  })
  @IsOptional()
  @IsIn(REP_KINDS)
  kind?: RepKind;

  @ApiPropertyOptional({ description: 'Substring search over name_ar / name_en / phone' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
