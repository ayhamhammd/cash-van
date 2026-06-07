import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsOptional, IsString, Length } from 'class-validator';

export class CreateWarehouseDto {
  @ApiProperty({ example: 'WH-01', description: 'Unique warehouse/van number' })
  @IsString()
  @Length(1, 32)
  whNumber!: string;

  @ApiProperty({ example: 'Main Warehouse', description: 'Warehouse display name' })
  @IsString()
  @Length(2, 200)
  whName!: string;

  @ApiPropertyOptional({ example: 'Amman, Jordan', description: 'Store address' })
  @IsOptional()
  @IsString()
  @Length(0, 512)
  whAddress?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  whCreditBox?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  whDebitBox?: string;
}
