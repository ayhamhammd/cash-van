import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({
    example: 'CTN24',
    description: 'Short code (e.g. PCE, CTN24, PAL). Unique. PCE is reserved for the base unit.',
  })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: 'كرتونة' })
  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @ApiPropertyOptional({ example: 'Carton' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @ApiProperty({
    example: 24,
    minimum: 1,
    description: 'How many base units (pieces) make one of this unit. PCE must be 1.',
  })
  @IsInt()
  @Min(1)
  baseQty!: number;
}

export class UpdateUnitDto extends PartialType(CreateUnitDto) {}
