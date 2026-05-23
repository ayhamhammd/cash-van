import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ minLength: 6 })
  @IsString()
  @Length(6, 128)
  newPassword!: string;
}
