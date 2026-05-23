import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumberString, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateYearConfigDto {
  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(1900)
  @Max(2999)
  year!: number;

  @ApiProperty()
  @IsString()
  @Length(1, 120)
  accName!: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  accValue?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  totalSale?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  totalD?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  totalR?: string;
}
