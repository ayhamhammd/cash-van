import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class HeartbeatDto {
  @ApiProperty({ description: 'Device location services (GPS) currently enabled?' })
  @IsBoolean()
  gpsEnabled!: boolean;

  @ApiPropertyOptional({
    enum: ['active', 'signed_out', 'closed'],
    default: 'active',
    description:
      "'signed_out' is the final heartbeat on day-close/logout (suppresses offline alerts); " +
      "'closed' is sent when the rep swipes the app away (fires an app-closed alert).",
  })
  @IsOptional()
  @IsIn(['active', 'signed_out', 'closed'])
  appState?: 'active' | 'signed_out' | 'closed';

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Battery percentage' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPct?: number;
}
