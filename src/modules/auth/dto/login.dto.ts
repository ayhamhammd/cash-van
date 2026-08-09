import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'U-0001', description: 'Unique user number / login code' })
  @IsString()
  @Length(1, 32)
  userNumber!: string;

  @ApiProperty({ example: 'SuperSecret#1' })
  @IsString()
  @Length(6, 128)
  password!: string;

  @ApiPropertyOptional({
    description:
      'Stable handset id (ANDROID_ID / identifierForVendor). Sent by the ' +
      'mobile app only. Its presence turns on device binding — one live ' +
      'handset per user and one user per handset — and returns a ' +
      '`trackingToken`. The dashboard omits it and is unaffected.',
    example: 'a1b2c3d4e5f60718',
  })
  @IsOptional()
  @IsString()
  @Length(4, 191)
  deviceId?: string;

  @ApiPropertyOptional({ example: 'android', description: 'android | ios' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  platform?: string;

  @ApiPropertyOptional({
    example: 'Samsung SM-A155F',
    description: "Shown on the office's release screen to identify the handset.",
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  deviceModel?: string;
}
