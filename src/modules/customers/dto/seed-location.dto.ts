import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsLatitude, IsLongitude, IsOptional } from 'class-validator';

/**
 * Body for `POST /v1/customers/:id/location`. By default a rep only bootstraps a
 * customer's GPS location (seed-once — fills an empty pin, never moves one). With
 * `overwrite: true` the rep MOVES the pin to the given coordinates (the "update
 * customer location" button). `class-validator`'s lat/lng checks accept numbers
 * or numeric strings.
 */
export class SeedLocationDto {
  @ApiProperty({ example: 31.951569, description: 'Latitude (WGS84)' })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 35.923963, description: 'Longitude (WGS84)' })
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'When true, MOVE an existing pin to these coordinates (overwrite). Default ' +
      'false keeps seed-once — only fills a customer that has no location yet.',
  })
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;
}
