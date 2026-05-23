import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class CreateChequeDto {
  @ApiProperty() @IsString() @Length(1, 200) bankName!: string;
  @ApiProperty() @IsString() @Length(1, 64) chequeNumber!: string;
  @ApiProperty() @IsDateString() chequeDate!: string;
  @ApiProperty() @IsDateString() dueDate!: string;
  @ApiProperty() @IsNumberString() amount!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() customerNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() customerName?: string;
}
