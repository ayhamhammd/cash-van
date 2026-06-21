import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CartLineDto {
  @ApiProperty()
  @IsString()
  itemNumber!: string;

  @ApiProperty({ example: 6, description: 'Quantity in sellable units.' })
  @IsNumber()
  @Min(0.001)
  qty!: number;
}

export class EvaluateOffersDto {
  @ApiPropertyOptional({ description: 'Customer the cart is for (drives eligibility + new-customer checks).' })
  @IsOptional()
  @IsString()
  customerNumber?: string;

  @ApiPropertyOptional({ description: 'Selling rep id (rep-scoped offers).' })
  @IsOptional()
  @IsString()
  repId?: string;

  @ApiPropertyOptional({ description: 'Store/van number (store-scoped offers).' })
  @IsOptional()
  @IsString()
  storeNumber?: string;

  @ApiPropertyOptional({ description: 'ISO datetime to evaluate at; defaults to now (schedule/day/time checks).' })
  @IsOptional()
  @IsDateString()
  at?: string;

  @ApiProperty({ type: [CartLineDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines!: CartLineDto[];
}
