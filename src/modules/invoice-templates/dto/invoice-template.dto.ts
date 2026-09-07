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

/**
 * Every document the designer can lay out = every voucher kind the company
 * issues (`voucher_headers.trans_kind`). See docs/SPEC-print-templates.md §1.
 */
export const DOCUMENT_TYPES = [
  'SALE',
  'RETURN',
  'ORDER',
  'TRANSFER',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'IN',
  'OUT',
  'PURCHASE',
  'ADJUSTMENT',
  'PAYMENT_IN',
  'PAYMENT_OUT',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** The kind's Arabic name — what `{{invoice.kindName}}` prints (spec §1). */
export const ARABIC_KIND_NAMES: Readonly<Record<DocumentType, string>> = {
  SALE: 'سند بيع',
  RETURN: 'سند مرتجع',
  ORDER: 'طلبية',
  TRANSFER: 'سند تحويل',
  TRANSFER_IN: 'تحميل المركبة',
  TRANSFER_OUT: 'تنزيل المركبة',
  IN: 'إدخال للمخزن',
  OUT: 'إخراج من المخزن',
  PURCHASE: 'سند شراء',
  ADJUSTMENT: 'تسوية',
  PAYMENT_IN: 'سند قبض',
  PAYMENT_OUT: 'سند صرف',
};

export const PAPER_SIZES = ['A4', 'A5', 'THERMAL_80'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export class CreateInvoiceTemplateDto {
  @ApiProperty({ example: 'Thermal receipt' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, example: 'SALE' })
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

/**
 * Which store is printing. `branchId` is the warehouse id; `storeNumber` is
 * its `whNumber` (what a device knows itself by) and is looked up.
 */
export class ResolveAllInvoiceTemplatesQueryDto {
  @ApiPropertyOptional({ description: 'Warehouse id the print is for.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  branchId?: string;

  @ApiPropertyOptional({ description: 'Warehouse number (whNumber), e.g. VAN1. Alternative to branchId.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeNumber?: string;
}

export class ResolveInvoiceTemplateQueryDto extends ResolveAllInvoiceTemplatesQueryDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType!: DocumentType;
}

export class BuiltinTemplateParamDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType!: DocumentType;
}

export class ListInvoiceTemplatesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  branchId?: string;
}
