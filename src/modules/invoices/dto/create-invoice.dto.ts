import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class InvoiceLineInputDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ minimum: 0.001, description: 'Supports fractional quantities' })
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Override unit price in fils; defaults to product.price' })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitPrice?: number;

  @ApiPropertyOptional({ enum: ['PERCENTAGE', 'FIXED_AMOUNT'], default: 'PERCENTAGE' })
  @IsOptional()
  @IsIn(['PERCENTAGE', 'FIXED_AMOUNT'])
  lineDiscountType?: 'PERCENTAGE' | 'FIXED_AMOUNT';

  @ApiPropertyOptional({ description: 'Percent (0-100) or fils, per lineDiscountType', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  lineDiscountValue?: number;
}

export class CreateInvoiceDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiProperty()
  @IsUUID()
  repId!: string;

  @ApiProperty({ type: [InvoiceLineInputDto], maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineInputDto)
  lines!: InvoiceLineInputDto[];

  @ApiPropertyOptional({ enum: ['PERCENTAGE', 'FIXED_AMOUNT'], default: 'PERCENTAGE' })
  @IsOptional()
  @IsIn(['PERCENTAGE', 'FIXED_AMOUNT'])
  invoiceDiscountType?: 'PERCENTAGE' | 'FIXED_AMOUNT';

  @ApiPropertyOptional({ description: 'Percent (0-100) or fils', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  invoiceDiscountValue?: number;

  @ApiPropertyOptional({ enum: ['012', '022'], default: '012', description: '012 cash | 022 receivable' })
  @IsOptional()
  @IsIn(['012', '022'])
  paymentMethodCode?: '012' | '022';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 128)
  deviceId?: string;
}
