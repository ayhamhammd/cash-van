import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A FastReport-style banded voucher template ("FR3 for vouchers"). The voucher
 * is laid out as ordered bands (title / header / detail / totals / footer); the
 * detail band repeats once per line item. Each band holds absolutely-positioned
 * elements (text / data field / line / box / QR / barcode) measured in
 * millimetres, so the same document renders identically on a thermal printer,
 * an A4 PDF, and the mobile app.
 *
 * Stored whole (not as a delta) on app_settings.voucher_report; when absent the
 * service returns DEFAULT_VOUCHER_REPORT.
 */

export const PAGE_SIZES = ['thermal58', 'thermal80', 'a4'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** Physical page width per size, in millimetres. */
export const PAGE_WIDTH_MM: Record<PageSize, number> = {
  thermal58: 58,
  thermal80: 80,
  a4: 210,
};

export const BAND_TYPES = ['title', 'header', 'detail', 'totals', 'footer'] as const;
export type BandType = (typeof BAND_TYPES)[number];

export const ELEMENT_TYPES = ['text', 'field', 'line', 'box', 'qr', 'barcode', 'logo'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const ALIGNMENTS = ['start', 'center', 'end'] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export const FONT_FAMILIES = ['mono', 'sans', 'serif'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/** A single positioned element inside a band. Geometry is in millimetres. */
export class ReportElementDto {
  @IsString()
  @Length(1, 64)
  id!: string;

  @IsIn(ELEMENT_TYPES)
  type!: ElementType;

  @IsNumber() @Min(0) @Max(400)
  x!: number;

  @IsNumber() @Min(0) @Max(400)
  y!: number;

  @IsNumber() @Min(0) @Max(400)
  w!: number;

  @IsNumber() @Min(0) @Max(400)
  h!: number;

  /** Data token for `field` / `qr` / `barcode` (e.g. "voucher.number", "item.name"). */
  @IsOptional() @IsString() @Length(0, 64)
  bind?: string;

  /** Static text for `text` elements. */
  @IsOptional() @IsString() @Length(0, 200)
  text?: string;

  /** Font size in points. */
  @IsOptional() @IsNumber() @Min(5) @Max(48)
  fontSize?: number;

  @IsOptional() @IsBoolean()
  bold?: boolean;

  @IsOptional() @IsIn(ALIGNMENTS)
  align?: Alignment;

  /** Draw a border around the element (or, for `box`, the box outline). */
  @IsOptional() @IsBoolean()
  border?: boolean;

  /** Stroke width in mm for `line` / `box`. */
  @IsOptional() @IsNumber() @Min(0.1) @Max(3)
  lineWidth?: number;
}

export class ReportBandDto {
  @IsIn(BAND_TYPES)
  type!: BandType;

  /** Band height in mm. The detail band repeats this height per line item. */
  @IsNumber() @Min(0) @Max(400)
  heightMm!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportElementDto)
  elements!: ReportElementDto[];
}

export class ReportPageDto {
  @IsIn(PAGE_SIZES)
  size: PageSize = 'thermal80';

  @IsNumber() @Min(0) @Max(40)
  marginMm = 4;

  @IsIn(FONT_FAMILIES)
  fontFamily: FontFamily = 'mono';

  @IsNumber() @Min(5) @Max(24)
  baseFontSize = 9;

  @IsString() @Length(1, 16)
  currency = 'د.أ';

  @IsNumber() @Min(0) @Max(4)
  amountDecimals = 3;

  /** Force Latin 0-9 digits even under Arabic (mirrors the v2 template). */
  @IsOptional() @IsBoolean()
  forceLatinDigits = true;
}

export class VoucherReportDto {
  @ValidateNested()
  @Type(() => ReportPageDto)
  page: ReportPageDto = new ReportPageDto();

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportBandDto)
  bands: ReportBandDto[] = [];
}

/** Plain resolved shape returned by GET/PUT. */
export type ReportElement = {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  bind?: string;
  text?: string;
  fontSize?: number;
  bold?: boolean;
  align?: Alignment;
  border?: boolean;
  lineWidth?: number;
};
export type ReportBand = { type: BandType; heightMm: number; elements: ReportElement[] };
export type VoucherReport = {
  page: {
    size: PageSize;
    marginMm: number;
    fontFamily: FontFamily;
    baseFontSize: number;
    currency: string;
    amountDecimals: number;
    forceLatinDigits: boolean;
  };
  bands: ReportBand[];
};

/**
 * The Jordan default voucher layout — an 80 mm thermal receipt. Content width is
 * 72 mm (80 − 2×4 margin). The app/admin starts from this and can drag-edit.
 */
export const DEFAULT_VOUCHER_REPORT: VoucherReport = {
  page: {
    size: 'thermal80',
    marginMm: 4,
    fontFamily: 'mono',
    baseFontSize: 9,
    currency: 'د.أ',
    amountDecimals: 3,
    forceLatinDigits: true,
  },
  bands: [
    {
      type: 'title',
      heightMm: 14,
      elements: [
        { id: 't-name', type: 'field', bind: 'company.name', x: 0, y: 1, w: 72, h: 6, fontSize: 14, bold: true, align: 'center' },
        { id: 't-sub', type: 'text', text: 'فاتورة ضريبية', x: 0, y: 8, w: 72, h: 4, fontSize: 8, align: 'center' },
        { id: 't-line', type: 'line', x: 0, y: 13, w: 72, h: 0, lineWidth: 0.3 },
      ],
    },
    {
      type: 'header',
      heightMm: 22,
      elements: [
        { id: 'h-numL', type: 'text', text: 'رقم الفاتورة', x: 44, y: 1, w: 28, h: 4, align: 'end' },
        { id: 'h-num', type: 'field', bind: 'voucher.number', x: 0, y: 1, w: 42, h: 4, align: 'start' },
        { id: 'h-dateL', type: 'text', text: 'التاريخ', x: 44, y: 6, w: 28, h: 4, align: 'end' },
        { id: 'h-date', type: 'field', bind: 'voucher.date', x: 0, y: 6, w: 42, h: 4, align: 'start' },
        { id: 'h-custL', type: 'text', text: 'العميل', x: 44, y: 11, w: 28, h: 4, align: 'end' },
        { id: 'h-cust', type: 'field', bind: 'voucher.customerName', x: 0, y: 11, w: 42, h: 4, align: 'start' },
        { id: 'h-pay', type: 'field', bind: 'voucher.paymentType', x: 0, y: 16, w: 20, h: 5, align: 'center', border: true, bold: true },
        { id: 'h-line', type: 'line', x: 0, y: 21, w: 72, h: 0, lineWidth: 0.3 },
      ],
    },
    {
      type: 'detail',
      heightMm: 5,
      elements: [
        { id: 'd-name', type: 'field', bind: 'item.name', x: 0, y: 0.5, w: 40, h: 4, align: 'start' },
        { id: 'd-qty', type: 'field', bind: 'item.qty', x: 40, y: 0.5, w: 10, h: 4, align: 'center' },
        { id: 'd-total', type: 'field', bind: 'item.lineTotal', x: 50, y: 0.5, w: 22, h: 4, align: 'end' },
      ],
    },
    {
      type: 'totals',
      heightMm: 20,
      elements: [
        { id: 'to-line', type: 'line', x: 0, y: 0, w: 72, h: 0, lineWidth: 0.3 },
        { id: 'to-subL', type: 'text', text: 'الإجمالي قبل الضريبة', x: 26, y: 2, w: 46, h: 4, align: 'end' },
        { id: 'to-sub', type: 'field', bind: 'totals.subtotal', x: 0, y: 2, w: 24, h: 4, align: 'start' },
        { id: 'to-taxL', type: 'text', text: 'الضريبة', x: 26, y: 6, w: 46, h: 4, align: 'end' },
        { id: 'to-tax', type: 'field', bind: 'totals.tax', x: 0, y: 6, w: 24, h: 4, align: 'start' },
        { id: 'to-grandL', type: 'text', text: 'الإجمالي', x: 26, y: 11, w: 46, h: 6, fontSize: 13, bold: true, align: 'end' },
        { id: 'to-grand', type: 'field', bind: 'totals.grand', x: 0, y: 11, w: 24, h: 6, fontSize: 13, bold: true, align: 'start' },
      ],
    },
    {
      type: 'footer',
      heightMm: 28,
      elements: [
        { id: 'f-qr', type: 'qr', bind: 'qr.tax', x: 26, y: 1, w: 20, h: 20 },
        { id: 'f-cap', type: 'text', text: 'الرمز الضريبي (JoFotara - ISTD)', x: 0, y: 22, w: 72, h: 4, fontSize: 7, align: 'center' },
      ],
    },
  ],
};
