import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ContainerBalanceQueryDto {
  @ApiPropertyOptional({ description: 'One customer only.' })
  @IsOptional()
  @IsString()
  customerNumber?: string;

  @ApiPropertyOptional({ description: 'One kind of container only (its item number).' })
  @IsOptional()
  @IsString()
  containerItemNumber?: string;

  @ApiPropertyOptional({
    description:
      'Restrict to the containers held by this salesman’s customers. A salesman ' +
      'calling this endpoint is pinned to their own code regardless of what they send.',
  })
  @IsOptional()
  @IsString()
  userCode?: string;

  @ApiPropertyOptional({
    description:
      'Only balances whose oldest unreturned container went out at least this ' +
      'many days ago — the chase list.',
    minimum: 0,
    maximum: 3650,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  minDaysOutstanding?: number;

  @ApiPropertyOptional({ default: 200, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
