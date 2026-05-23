import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class RouteStopInputDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional({ description: 'Override order; defaults to array index' })
  @IsOptional()
  @IsInt()
  @Min(1)
  stopOrder?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  estDurationMin?: number;
}

export class CreateRoutePlanDto {
  @ApiProperty()
  @IsUUID()
  repId!: string;

  @ApiProperty({ example: '2026-05-21', description: 'YYYY-MM-DD' })
  @IsDateString()
  planDate!: string;

  @ApiProperty({ type: [RouteStopInputDto], maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RouteStopInputDto)
  stops!: RouteStopInputDto[];
}
