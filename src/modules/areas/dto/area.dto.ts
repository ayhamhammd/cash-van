import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateAreaDto {
  @ApiProperty({ example: 'الزرقاء الجديدة' })
  @IsString()
  @Length(1, 120)
  nameAr!: string;

  @ApiPropertyOptional({ example: 'New Zarqa' })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  nameEn?: string;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a hex colour like #3B82F6' })
  color?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateAreaDto extends PartialType(CreateAreaDto) {}

export class AreaMembersDto {
  @ApiProperty({ type: [String], description: 'Customers to move into this area.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  customerIds!: string[];
}

export class ListAreaMembersQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
