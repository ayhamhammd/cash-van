import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  Length,
} from 'class-validator';

export class CreateItemDto {
  @ApiProperty({ example: 'IT-1001', description: 'Unique item number' })
  @IsString()
  @Length(1, 32)
  itemNumber!: string;

  @ApiProperty({ example: 'Cola 330ml', description: 'Item display name' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: 'B-1001', description: 'Primary barcode' })
  @IsString()
  @Length(1, 64)
  barcode!: string;

  @ApiPropertyOptional({ default: '0', description: '0..100' })
  @IsOptional()
  @IsNumberString()
  taxPercentage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  photoUrl?: string;
}
