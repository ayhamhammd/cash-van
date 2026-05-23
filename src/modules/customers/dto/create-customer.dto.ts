import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import type { CustomerType } from '../entities/customer.entity';

const TYPES: CustomerType[] = ['CASH', 'CREDIT', 'WHOLESALE', 'RETAIL'];

export class CreateCustomerDto {
  @ApiProperty()
  @IsString()
  @Length(1, 32)
  customerNumber!: string;

  @ApiProperty({ description: 'Display name (legacy field)' })
  @IsString()
  @Length(2, 200)
  customerName!: string;

  @ApiPropertyOptional({ description: 'Arabic name; defaults to customerName' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 32)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  addressAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 100)
  city?: string;

  @ApiPropertyOptional({ example: 'JO-AM' })
  @IsOptional()
  @IsString()
  @Length(0, 16)
  cityCode?: string;

  @ApiPropertyOptional({ description: 'Freeform location text' })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: string;

  @ApiPropertyOptional({ description: 'Assigned rep UUID' })
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ description: 'Region UUID' })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ example: 'retail' })
  @IsOptional()
  @IsString()
  @Length(0, 32)
  category?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  creditLimit?: string;

  @ApiPropertyOptional({ default: 30, description: 'Payment terms in days' })
  @IsOptional()
  @IsInt()
  @Min(0)
  paymentTerms?: number;

  @ApiPropertyOptional({ enum: TYPES, default: 'CASH' })
  @IsOptional()
  @IsIn(TYPES)
  customerType?: CustomerType;

  @ApiPropertyOptional({ description: 'Tax ID (B2B)' })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  tin?: string;

  @ApiPropertyOptional({ description: 'National ID' })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  nin?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 64)
  passportNumber?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
