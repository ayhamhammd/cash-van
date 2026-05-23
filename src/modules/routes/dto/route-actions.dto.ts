import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReorderStopDto {
  @ApiProperty({ description: 'route_stops.id (bigint as string)' })
  @IsString()
  stopId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  stopOrder!: number;
}

export class ReorderStopsDto {
  @ApiProperty({ type: [ReorderStopDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReorderStopDto)
  order!: ReorderStopDto[];
}

export class MarkVisitedDto {
  @ApiPropertyOptional({ description: 'ISO 8601; defaults to now()' })
  @IsOptional()
  @IsDateString()
  actualArrival?: string;

  @ApiPropertyOptional({ description: 'ISO 8601' })
  @IsOptional()
  @IsDateString()
  actualDeparture?: string;
}

export class MarkSkippedDto {
  @ApiProperty()
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class GenerateRoutesDto {
  @ApiProperty({ type: [String], description: 'Rep UUIDs to generate routes for' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  repIds!: string[];

  @ApiProperty({ example: '2026-05-21', description: 'YYYY-MM-DD' })
  @IsDateString()
  planDate!: string;
}
