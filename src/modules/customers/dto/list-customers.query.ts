import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class ListCustomersQuery {
  @ApiPropertyOptional({ description: 'Substring match on Arabic/English name + number' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'RFM segment key' })
  @IsOptional()
  @IsString()
  segment?: string;

  @ApiPropertyOptional({ enum: ['loyal', 'at_risk', 'high_risk'] })
  @IsOptional()
  @IsIn(['loyal', 'at_risk', 'high_risk'])
  churnRisk?: 'loyal' | 'at_risk' | 'high_risk';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 25;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
