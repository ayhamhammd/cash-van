import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/** Open a working day. */
export class OpenShiftDto {
  @ApiProperty()
  @IsUUID()
  repId!: string;

  @ApiPropertyOptional({
    description:
      'When the rep actually opened, ISO 8601. Defaults to now(). Send the ' +
      'handset time: a shift that syncs after an outage must not be recorded as ' +
      'starting when coverage came back.',
  })
  @IsOptional()
  @IsISO8601()
  openedAt?: string;

  @ApiPropertyOptional({ description: 'Where the rep opened.' })
  @IsOptional()
  @IsLatitude()
  openLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  openLng?: number;

  @ApiPropertyOptional({
    description:
      "The handset's own id for this shift. A fresh random UUID — a replay is " +
      'answered 409 with the original, so a retried open cannot become a second ' +
      'working day.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  clientRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

/** Close the rep's open day. */
export class CloseShiftDto {
  @ApiPropertyOptional({ description: 'When the rep closed, ISO 8601. Defaults to now().' })
  @IsOptional()
  @IsISO8601()
  closedAt?: string;

  @ApiPropertyOptional({ description: 'Where the rep closed.' })
  @IsOptional()
  @IsLatitude()
  closeLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  closeLng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}
