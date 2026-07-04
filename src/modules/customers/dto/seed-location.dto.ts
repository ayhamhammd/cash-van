import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';

/**
 * Body for `POST /v1/customers/:id/location` — a rep bootstrapping a customer's
 * GPS location. Only ever fills an empty pin (seed-once); admins edit/remove via
 * PATCH. `class-validator`'s lat/lng checks accept numbers or numeric strings.
 */
export class SeedLocationDto {
  @ApiProperty({ example: 31.951569, description: 'Latitude (WGS84)' })
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 35.923963, description: 'Longitude (WGS84)' })
  @IsLongitude()
  lng!: number;
}
