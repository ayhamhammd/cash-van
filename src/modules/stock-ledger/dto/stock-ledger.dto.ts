import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class StockCardQueryDto {
  @ApiProperty({ description: 'Store (warehouse) number' })
  @IsString()
  @Length(1, 64)
  store!: string;

  @ApiProperty({ description: 'Item number' })
  @IsString()
  @Length(1, 64)
  itemNumber!: string;

  @ApiPropertyOptional({ description: "The pool: a variant unit's code; omit for base pieces" })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  stockUnitCode?: string;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ description: 'Page backwards: movements with seq below this' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeSeq?: number;
}
