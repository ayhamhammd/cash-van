import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  Min,
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

  @ApiPropertyOptional({ default: 0, description: 'Sale price in fils (minor units; 1 JOD = 1000 fils)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ default: 0, description: 'Unit cost in fils (minor units; 1 JOD = 1000 fils)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  cost?: number;

  @ApiPropertyOptional({ default: '0', description: '0..100' })
  @IsOptional()
  @IsNumberString()
  taxPercentage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  photoUrl?: string;

  @ApiPropertyOptional({
    description:
      'Product image URL (absolute, or a relative ERP upload path). Shown in the app + dashboard.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string;
}
