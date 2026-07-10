import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePriceListDto {
  @ApiProperty({ description: 'Unique code, e.g. WHOLESALE.' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: 'Display name.' })
  @IsString()
  @MaxLength(120)
  name!: string;
}

export class UpdatePriceListDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetPriceListItemDto {
  @ApiProperty({ description: 'Product id (item_cart.id).' })
  @IsUUID()
  itemId!: string;

  @ApiProperty({ description: 'Unit price in fils (integer).', example: 9500 })
  @IsInt()
  @Min(0)
  unitPrice!: number;
}

export class AssignPriceListDto {
  @ApiProperty({ description: 'Customer id (customers.id).' })
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional({ description: 'Price list id, or null to clear.', nullable: true })
  @IsOptional()
  @IsUUID()
  priceListId?: string | null;
}
