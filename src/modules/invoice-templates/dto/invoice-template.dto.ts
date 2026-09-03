import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Every document the designer can lay out. Mirrors the frontend DocumentType. */
export const DOCUMENT_TYPES = [
  'SALE_INVOICE',
  'RETURN_INVOICE',
  'HOLD_INVOICE',
  'X_REPORT',
  'Z_REPORT',
  'REPORT_SALES',
  'REPORT_INVOICES',
  'REPORT_PROFIT',
  'REPORT_TOP_SELLING',
  'REPORT_CATEGORIES',
  'REPORT_BY_HOUR',
  'REPORT_COMPARISON',
  'REPORT_TAX',
  'REPORT_PAYMENTS',
  'REPORT_RETURNS',
  'REPORT_DISCOUNTS',
  'REPORT_VOUCHERS',
  'REPORT_INVENTORY',
  'REPORT_LOW_STOCK',
  'REPORT_MOVEMENT',
  'REPORT_TOP_CUSTOMERS',
  'REPORT_CREDIT',
  'REPORT_EMPLOYEES',
  'REPORT_Z',
  'REPORT_X',
  'REPORT_DAILY_CLOSE',
  'REPORT_MULTI_BRANCH',
  'SCALE_LABEL',
  'BARCODE_LABEL',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const PAPER_SIZES = ['A4', 'A5', 'THERMAL_80'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export class CreateInvoiceTemplateDto {
  @ApiProperty({ example: 'Thermal receipt' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, example: 'SALE_INVOICE' })
  @IsIn(DOCUMENT_TYPES)
  documentType!: DocumentType;

  @ApiPropertyOptional({ enum: PAPER_SIZES, default: 'A4' })
  @IsOptional()
  @IsIn(PAPER_SIZES)
  paperSize?: PaperSize;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'Branch (store) this template is pinned to; null/omitted = global.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  branchId?: string | null;

  @ApiProperty({ description: 'Designer layout JSON (zones + elements, mm).' })
  @IsObject()
  layout!: Record<string, unknown>;
}

/** documentType is fixed once created — the fallback chain keys on it. */
export class UpdateInvoiceTemplateDto extends PartialType(CreateInvoiceTemplateDto) {}

export class ResolveInvoiceTemplateQueryDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType!: DocumentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  branchId?: string;
}

export class ListInvoiceTemplatesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  branchId?: string;
}
