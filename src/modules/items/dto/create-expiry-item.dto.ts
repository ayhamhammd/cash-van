import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class CreateExpiryItemDto {
  @ApiProperty()
  @IsString()
  @Length(1, 32)
  itemNumber!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  itemName!: string;

  @ApiProperty({ example: '2026-12-31' })
  @IsDateString()
  expDate!: string;

  @ApiProperty({ example: '2026-05-13' })
  @IsDateString()
  inDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 32)
  storeNumber?: string;
}
