import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class LogoutDto {
  @ApiPropertyOptional({
    description:
      'Handset signing out. Marks its session closed while leaving the ' +
      'binding and the tracking token intact.',
  })
  @IsOptional()
  @IsString()
  @Length(4, 191)
  deviceId?: string;
}
