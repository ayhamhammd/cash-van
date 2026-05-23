import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'U-0001', description: 'Unique user number / login code' })
  @IsString()
  @Length(1, 32)
  userNumber!: string;

  @ApiProperty({ example: 'SuperSecret#1' })
  @IsString()
  @Length(6, 128)
  password!: string;
}
