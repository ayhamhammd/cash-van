import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

export class CreateProductCategoryDto {
  @ApiProperty({ example: 'مشروبات' })
  @IsString()
  @Length(1, 200)
  nameAr!: string;

  @ApiPropertyOptional({ example: 'Beverages' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string;

  @ApiPropertyOptional({ description: 'Parent category UUID' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateProductCategoryDto extends PartialType(CreateProductCategoryDto) {}
