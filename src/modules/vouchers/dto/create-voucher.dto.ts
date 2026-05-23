import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import type { PaymentType } from '../entities/payment.entity';

const PAYMENT_TYPES: PaymentType[] = ['CASH', 'CHEQUE', 'TRANSFER', 'CARD', 'CREDIT'];

export class VoucherLineDto {
  @ApiProperty()
  @IsString()
  @Length(1, 32)
  itemNumber!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  itemName!: string;

  @ApiProperty({ example: '1.000' })
  @IsNumberString()
  itemQty!: string;

  @ApiProperty({ example: '1.250' })
  @IsNumberString()
  unitPrice!: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  taxPercentage?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  discountPercentage?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  discountValue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storeNumber?: string;

  @ApiPropertyOptional({ description: 'Defaults to header trans_kind' })
  @IsOptional()
  @IsString()
  transKind?: string;
}

export class VoucherPaymentDto {
  @ApiProperty({ example: '12.500' })
  @IsNumberString()
  amount!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fromAcc?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  toAcc?: string;

  @ApiProperty({ enum: PAYMENT_TYPES, default: 'CASH' })
  @IsIn(PAYMENT_TYPES)
  paymentType!: PaymentType;
}

export class CreateVoucherDto {
  @ApiProperty()
  @IsString()
  @Length(1, 32)
  voucherNumber!: string;

  @ApiProperty({ example: 'SALE' })
  @IsString()
  @Length(1, 32)
  transKind!: string;

  @ApiProperty()
  @IsString()
  userCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  inDate?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  totalDiscountValue?: string;

  @ApiPropertyOptional({ default: '0' })
  @IsOptional()
  @IsNumberString()
  totalDiscountPercentage?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPosted?: boolean;

  @ApiProperty({ type: [VoucherLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VoucherLineDto)
  transactions!: VoucherLineDto[];

  @ApiPropertyOptional({ type: [VoucherPaymentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VoucherPaymentDto)
  payments?: VoucherPaymentDto[];
}
