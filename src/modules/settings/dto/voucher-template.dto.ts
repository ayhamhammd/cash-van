import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Voucher (receipt) template — v2 "web editor base" contract. The mobile app
 * fetches the resolved template once per session and renders the printed voucher
 * from it; the editor (website) edits it. JSON keys are the wire contract — never
 * rename, add-only. The app ignores unknown keys, so the editor/backend can ship
 * a field before the app reads it.
 *
 * Resolution: stored per-tenant as a DEEP override delta over BASE_VOUCHER_TEMPLATE
 * (only leaves that differ); the service deep-merges on read. `PUT {}` resets to base.
 *
 * The division of responsibility: this template controls WHAT shows and the
 * values (toggles, text, currency, rates, logo). The app owns pixel layout, RTL
 * shaping, and the monochrome rule.
 */

export const LOGO_SOURCES = ['SERVER_THEN_DEFAULT', 'SERVER_ONLY', 'DEFAULT_ONLY'] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];

export const QR_SOURCES = ['SERVER', 'LOCAL'] as const;
export type QrSource = (typeof QR_SOURCES)[number];

export const COLUMN_KEYS = ['QTY', 'UNIT', 'TAX', 'PRICE', 'DISCOUNT', 'TOTAL'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

class LogoDto {
  @IsOptional() @IsBoolean()
  show = true;

  @IsOptional() @IsIn(LOGO_SOURCES)
  source: LogoSource = 'SERVER_THEN_DEFAULT';

  @IsOptional() @IsInt() @Min(24) @Max(96)
  heightDp = 54;
}

class CompanyHeaderDto {
  @IsOptional() @IsBoolean() showName = true;
  @IsOptional() @IsBoolean() showTaxNumber = true;
  @IsOptional() @IsBoolean() showBranch = true;
  @IsOptional() @IsBoolean() showAddress = false;
  @IsOptional() @IsBoolean() showPhone = false;
}

class QrDto {
  @IsOptional() @IsBoolean()
  show = false;

  @IsOptional() @IsString() @Length(1, 64)
  caption = 'الرمز الضريبي (JoFotara - ISTD)';

  @IsOptional() @IsIn(QR_SOURCES)
  source: QrSource = 'SERVER';
}

class SignatureDto {
  @IsOptional() @IsBoolean() showRecipient = true;
  @IsOptional() @IsBoolean() showStamp = false;
}

class FooterDto {
  @IsOptional() @IsString() @Length(0, 120)
  thanksText = 'شكراً لتعاملكم معنا';

  @IsOptional() @IsString() @Length(0, 60)
  poweredByText = 'Powered by 7Software';

  @IsOptional() @IsBoolean()
  showPoweredBy = true;
}

export class VoucherTemplateDto {
  @IsOptional() @IsIn([2])
  schemaVersion = 2;

  // ── Money & numbers ─────────────────────────────────────────────────────
  @IsOptional() @IsString() @Length(1, 64)
  currency = 'د.أ';

  @IsOptional() @IsInt() @Min(0) @Max(4)
  amountDecimals = 3;

  @IsOptional() @IsBoolean()
  forceLatinDigits = true;

  // ── Tax ─────────────────────────────────────────────────────────────────
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  defaultTaxPct = 16.0;

  @IsOptional() @IsBoolean()
  showTaxColumn = true;

  @IsOptional() @IsBoolean()
  taxColumnShowsPercent = true;

  // ── Theme ───────────────────────────────────────────────────────────────
  @IsOptional() @IsBoolean()
  monochrome = true;

  // ── Logo / company header ───────────────────────────────────────────────
  @IsOptional() @ValidateNested() @Type(() => LogoDto)
  logo: LogoDto = new LogoDto();

  @IsOptional() @ValidateNested() @Type(() => CompanyHeaderDto)
  companyHeader: CompanyHeaderDto = new CompanyHeaderDto();

  // ── Item table ──────────────────────────────────────────────────────────
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(COLUMN_KEYS, { each: true })
  columns: ColumnKey[] = ['QTY', 'UNIT', 'TAX', 'PRICE', 'DISCOUNT', 'TOTAL'];

  // ── Payment type ────────────────────────────────────────────────────────
  @IsOptional() @IsBoolean() showPaymentType = true;
  @IsOptional() @IsBoolean() paymentTypeInHeader = true;
  @IsOptional() @IsBoolean() paymentTypeInFooter = true;

  // ── Totals & discounts ──────────────────────────────────────────────────
  @IsOptional() @IsBoolean() showItemCount = true;
  @IsOptional() @IsBoolean() showLineDiscount = true;
  @IsOptional() @IsBoolean() showTotalDiscount = true;
  @IsOptional() @IsBoolean() showFreeItems = true;

  // ── Tax QR / signature / footer ─────────────────────────────────────────
  @IsOptional() @ValidateNested() @Type(() => QrDto)
  qr: QrDto = new QrDto();

  @IsOptional() @ValidateNested() @Type(() => SignatureDto)
  signature: SignatureDto = new SignatureDto();

  @IsOptional() @ValidateNested() @Type(() => FooterDto)
  footer: FooterDto = new FooterDto();
}

/** Plain (validator-free) resolved shape returned by GET/PUT. */
export interface VoucherTemplate {
  schemaVersion: number;
  currency: string;
  amountDecimals: number;
  forceLatinDigits: boolean;
  defaultTaxPct: number;
  showTaxColumn: boolean;
  taxColumnShowsPercent: boolean;
  monochrome: boolean;
  logo: { show: boolean; source: LogoSource; heightDp: number };
  companyHeader: {
    showName: boolean;
    showTaxNumber: boolean;
    showBranch: boolean;
    showAddress: boolean;
    showPhone: boolean;
  };
  columns: ColumnKey[];
  showPaymentType: boolean;
  paymentTypeInHeader: boolean;
  paymentTypeInFooter: boolean;
  showItemCount: boolean;
  showLineDiscount: boolean;
  showTotalDiscount: boolean;
  showFreeItems: boolean;
  qr: { show: boolean; caption: string; source: QrSource };
  signature: { showRecipient: boolean; showStamp: boolean };
  footer: { thanksText: string; poweredByText: string; showPoweredBy: boolean };
}

/**
 * Jordan rollout base template (schemaVersion 2). Custom tenant overrides
 * deep-merge ON TOP of this; only leaves that differ are stored, so changing
 * this base later automatically reaches a tenant that never customized it.
 */
export const BASE_VOUCHER_TEMPLATE: VoucherTemplate = {
  schemaVersion: 2,
  currency: 'د.أ',
  amountDecimals: 3,
  forceLatinDigits: true,
  defaultTaxPct: 16.0,
  showTaxColumn: true,
  taxColumnShowsPercent: true,
  monochrome: true,
  logo: { show: true, source: 'SERVER_THEN_DEFAULT', heightDp: 54 },
  companyHeader: {
    showName: true,
    showTaxNumber: true,
    showBranch: true,
    showAddress: false,
    showPhone: false,
  },
  columns: ['QTY', 'UNIT', 'TAX', 'PRICE', 'DISCOUNT', 'TOTAL'],
  showPaymentType: true,
  paymentTypeInHeader: true,
  paymentTypeInFooter: true,
  showItemCount: true,
  showLineDiscount: true,
  showTotalDiscount: true,
  showFreeItems: true,
  qr: { show: false, caption: 'الرمز الضريبي (JoFotara - ISTD)', source: 'SERVER' },
  signature: { showRecipient: true, showStamp: false },
  footer: { thanksText: 'شكراً لتعاملكم معنا', poweredByText: 'Powered by 7Software', showPoweredBy: true },
};
