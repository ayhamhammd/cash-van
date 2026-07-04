import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Min,
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

  @ApiProperty({
    example: '1.000',
    description:
      'Quantity in the chosen unit (e.g. 3 boxes). Multiplied by unitBaseQty to get base pieces for stock.',
  })
  @IsNumberString()
  itemQty!: string;

  @ApiProperty({ example: '1.250' })
  @IsNumberString()
  unitPrice!: string;

  @ApiPropertyOptional({ description: 'Unit code used for this line (e.g. "PK6"). Omit for base pieces.' })
  @IsOptional()
  @IsString()
  unitCode?: string;

  @ApiPropertyOptional({ description: 'Unit display-name snapshot.' })
  @IsOptional()
  @IsString()
  unitName?: string;

  @ApiPropertyOptional({
    description:
      'Pieces per unit (conversion factor). itemQty × unitBaseQty = base pieces moved into stock. Defaults to 1.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  unitBaseQty?: number;

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

  @ApiPropertyOptional({
    description:
      'Single store affected by this line (SALE source / RETURN target). For a TRANSFER use fromStoreNumber + toStoreNumber instead.',
  })
  @IsOptional()
  @IsString()
  storeNumber?: string;

  @ApiPropertyOptional({
    description:
      'Stock that loses qty (outflow). Required on each line of a TRANSFER voucher; ignored otherwise.',
  })
  @IsOptional()
  @IsString()
  fromStoreNumber?: string;

  @ApiPropertyOptional({
    description:
      'Stock that gains qty (inflow). Required on each line of a TRANSFER voucher; ignored otherwise.',
  })
  @IsOptional()
  @IsString()
  toStoreNumber?: string;

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
  @ApiPropertyOptional({
    description:
      'Auto-generated when omitted: <prefix>-<userCode><6-digit serial> (e.g. INV-U-0001000001).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  voucherNumber?: string;

  @ApiProperty({ example: 'SALE' })
  @IsString()
  @Length(1, 32)
  transKind!: string;

  @ApiPropertyOptional({
    description:
      'Multi-purpose reference. RETURN: the original SALE voucher number. ' +
      'SALE: the ORDER voucher it was converted from. ' +
      "PURCHASE: the supplier's own invoice number.",
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  referenceVoucherNumber?: string;

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

  @ApiPropertyOptional({
    type: [String],
    description:
      'SALE only. Offer ids applied to this sale (from POST /offers/evaluate). ' +
      'Stamped onto the voucher; redemptions recorded best-effort.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  appliedOfferIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'SALE only. Gift items the rep chose for ITEM_QTY_REWARD offers; the ' +
      'server validates them against the offer pool and adds them as free lines.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chosenFreeItems?: string[];

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
