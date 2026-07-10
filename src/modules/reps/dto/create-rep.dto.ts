import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateRepDto {
  @ApiPropertyOptional({
    example: 'S012',
    description: 'Human salesman code used by the mobile app. Unique when set.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @ApiProperty({ example: 'خالد العلي' })
  @IsString()
  @MaxLength(255)
  nameAr!: string;

  @ApiPropertyOptional({ example: 'Khaled Al-Ali' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nameEn?: string;

  @ApiPropertyOptional({ example: '+962790000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ description: 'Linked dashboard user (optional)' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Region UUID (FK added in plan 02)' })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ description: 'Assigned van/warehouse UUID' })
  @IsOptional()
  @IsUUID()
  vanId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'When true ("add with store"), auto-create a store (warehouse) for ' +
      'this salesman. The store number equals the salesman code and the ' +
      'store name equals the salesman name. Requires `code` to be set.',
  })
  @IsOptional()
  @IsBoolean()
  createStore?: boolean;

  @ApiPropertyOptional({ example: '2024-01-15' })
  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @ApiPropertyOptional({
    description: 'Daily revenue target in fils (1 JOD = 1000 fils)',
    example: 500000,
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyQuotaFils?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: "The rep's ERP GL account id (chart-of-accounts) that settlements post against.",
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(128)
  erpAccountId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Snapshot of the ERP account code · name.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  erpAccountCode?: string | null;
}
