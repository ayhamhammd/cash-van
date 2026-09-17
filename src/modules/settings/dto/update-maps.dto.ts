import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Set or rotate the Google Maps browser key from Settings (admin only). */
export class UpdateMapsDto {
  @ApiPropertyOptional({
    description:
      'Google Maps JavaScript API key. Omit to keep the current one; send an ' +
      'empty string to clear it and fall back to the server environment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;

  @ApiPropertyOptional({
    description: 'Optional Map ID for a cloud-styled map. Empty string clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mapId?: string;
}
