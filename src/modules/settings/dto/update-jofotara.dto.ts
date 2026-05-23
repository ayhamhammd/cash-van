import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateJoFotaraDto {
  @ApiProperty({ description: 'JoFotara API client identifier' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  clientId!: string;

  @ApiProperty({ description: 'JoFotara API secret (plaintext; encrypted before storage)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  secretKey!: string;

  @ApiPropertyOptional({ description: 'Hit sandbox vs production', default: true })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
}
