import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

export const VOUCHER_SUMMARY_KINDS = [
  'SALE',
  'RETURN',
  'ORDER',
  'COLLECTION',
  'ALL',
] as const;
export type VoucherSummaryKind = (typeof VOUCHER_SUMMARY_KINDS)[number];

export const VOUCHER_SUMMARY_PAYMENTS = ['CASH', 'CREDIT', 'ALL'] as const;
export type VoucherSummaryPayment = (typeof VOUCHER_SUMMARY_PAYMENTS)[number];

export class VoucherSummaryQuery {
  @ApiPropertyOptional({ description: 'Inclusive start date (YYYY-MM-DD).' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    description:
      'Inclusive end date (YYYY-MM-DD). The whole day is included, not up to midnight.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Salesman. Omit for all.' })
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ enum: VOUCHER_SUMMARY_KINDS, default: 'ALL' })
  @IsOptional()
  @IsIn(VOUCHER_SUMMARY_KINDS)
  transKind?: VoucherSummaryKind;

  @ApiPropertyOptional({
    enum: VOUCHER_SUMMARY_PAYMENTS,
    default: 'ALL',
    description:
      'CREDIT = the voucher carries at least one on-account payment. CASH = everything else (cash, cheque, transfer), matching how the offers engine reads payment condition.',
  })
  @IsOptional()
  @IsIn(VOUCHER_SUMMARY_PAYMENTS)
  payment?: VoucherSummaryPayment;
}
