import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class HeartbeatDto {
  @ApiProperty({ description: 'Device location services (GPS) currently enabled?' })
  @IsBoolean()
  gpsEnabled!: boolean;

  @ApiPropertyOptional({
    enum: ['active', 'signed_out'],
    default: 'active',
    description:
      "'signed_out' is the final heartbeat sent on day-close/logout — it suppresses offline alerts.",
  })
  @IsOptional()
  @IsIn(['active', 'signed_out'])
  appState?: 'active' | 'signed_out';

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Battery percentage' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPct?: number;
}
