import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { GeoJsonPolygon } from '../../../common/geo/geo.util';

export class CreateRegionDto {
  @ApiProperty({ example: 'شمال عمان' })
  @IsString()
  @MaxLength(255)
  nameAr!: string;

  @ApiPropertyOptional({ example: 'North Amman' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nameEn?: string;

  @ApiPropertyOptional({
    description:
      'GeoJSON Polygon. First and last positions of every ring must be identical (closed).',
    example: {
      type: 'Polygon',
      coordinates: [
        [
          [35.85, 31.95],
          [35.95, 31.95],
          [35.95, 32.05],
          [35.85, 32.05],
          [35.85, 31.95],
        ],
      ],
    },
  })
  @IsOptional()
  @IsObject()
  boundary?: GeoJsonPolygon;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
