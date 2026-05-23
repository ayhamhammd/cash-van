import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class RecordLocationDto {
  @ApiProperty({ example: 31.95, minimum: -90, maximum: 90 })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 35.91, minimum: -180, maximum: 180 })
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({ description: 'Accuracy in meters', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  accuracyM?: number;

  @ApiPropertyOptional({
    description:
      'When the device captured the point (ISO 8601). Defaults to server now() if absent.',
  })
  @IsOptional()
  @IsDateString()
  recordedAt?: string;
}

export class BulkRecordLocationDto {
  @ApiProperty({ type: [RecordLocationDto], maxItems: 500 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RecordLocationDto)
  points!: RecordLocationDto[];
}
