/**
 * Canonical voucher money engine — the SINGLE source of truth for tax + discount
 * math, shared (by definition, not by import) across the cash-van backend, the
 * FlowVan app (Kotlin port) and the ERP (rounding-aligned). Every system MUST
 * reproduce these exact numbers for a given input — see voucher-calc.spec.ts and
 * docs/VOUCHER-CALC-SPEC.md.
 *
 * ALL amounts are integer **fils** (JOD × 1000). Quantities may be fractional.
 * Rounding: round-half-up to the nearest fil at each step (Math.round).
 *
 * Jordan GST: rate is per item (commonly 16%). Two modes:
 *   EXCLUSIVE ("excluded") — price is pre-tax; tax is added on top.
 *   INCLUSIVE ("included") — price already contains tax; tax is extracted.
 *
 * Discounts:
 *   line   = percentage AND/OR fixed value (both stack), clamped to the line gross.
 *   header = ONE voucher-level discount (percentage OR fixed value), applied to the
 *            PRE-TAX net and distributed across lines by net share; tax is then
 *            computed on each line's post-distribution net.
 */

export type TaxMode = 'INCLUSIVE' | 'EXCLUSIVE';

export interface CalcLineInput {
  /** Per (sold) unit price in integer fils, >= 0. */
  unitPriceFils: number;
  /** Quantity in the sold unit; may be fractional (e.g. 1.5). */
  qty: number;
  /** Line discount percentage, 0..100. */
  lineDiscountPct?: number;
  /** Line fixed discount in integer fils, >= 0. Stacks on top of the percentage. */
  lineDiscountFils?: number;
  /** Tax rate percentage for this line, e.g. 16. */
  taxRatePct?: number;
}

export interface CalcInput {
  lines: CalcLineInput[];
  taxMode: TaxMode;
  /** Voucher-level discount percentage, 0..100 (takes precedence when > 0). */
  headerDiscountPct?: number;
  /** Voucher-level fixed discount in integer fils (used when pct is 0). */
  headerDiscountFils?: number;
}

export interface CalcLineResult {
  grossFils: number; // round(unitPrice × qty)
  lineDiscountFils: number; // % + fixed, clamped to gross
  netBeforeHeaderFils: number; // gross − lineDiscount
  headerShareFils: number; // this line's slice of the header discount
  netFils: number; // netBeforeHeader − headerShare (the EXCLUSIVE taxable base)
  taxableFils: number; // tax base: EXCLUSIVE = net; INCLUSIVE = net / (1 + rate)
  taxFils: number;
  totalFils: number; // EXCLUSIVE = net + tax; INCLUSIVE = net (tax is inside)
}

export interface CalcResult {
  lines: CalcLineResult[];
  totalNetFils: number; // Σ taxableFils (the tax base)
  totalTaxFils: number; // Σ tax
  grandTotalFils: number; // Σ total (what the customer pays)
  totalLineDiscountFils: number; // Σ line discounts
  headerDiscountFils: number; // resolved header discount value
  totalDiscountFils: number; // line + header
}

const r = (n: number): number => Math.round(n);
const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

/** The canonical calculation. Pure; deterministic; integer-fils in and out. */
export function calcVoucher(input: CalcInput): CalcResult {
  const mode = input.taxMode;

  // ── 1. Per-line gross, line discount (% then fixed, stacked), net-before-header
  const pre = input.lines.map((l) => {
    const gross = r((l.unitPriceFils || 0) * (l.qty || 0));
    const fromPct = r(gross * ((l.lineDiscountPct || 0) / 100));
    const fixed = Math.max(0, r(l.lineDiscountFils || 0));
    const lineDiscount = clamp(fromPct + fixed, 0, gross);
    return {
      gross,
      lineDiscount,
      netBeforeHeader: gross - lineDiscount,
      taxRatePct: l.taxRatePct || 0,
    };
  });

  // ── 2. Header discount (pct of net, or fixed), distributed by net share
  const sumNet = pre.reduce((s, p) => s + p.netBeforeHeader, 0);
  const headerRaw =
    input.headerDiscountPct && input.headerDiscountPct > 0
      ? r(sumNet * (input.headerDiscountPct / 100))
      : Math.max(0, r(input.headerDiscountFils || 0));
  const headerDisc = clamp(headerRaw, 0, sumNet);

  const shares = pre.map((p) =>
    sumNet > 0 ? r(headerDisc * (p.netBeforeHeader / sumNet)) : 0,
  );
  // Push the rounding remainder onto the last line with net > 0 so the
  // distributed shares sum EXACTLY to headerDisc.
  const distributed = shares.reduce((s, x) => s + x, 0);
  const diff = headerDisc - distributed;
  if (diff !== 0) {
    for (let i = pre.length - 1; i >= 0; i--) {
      if (pre[i].netBeforeHeader > 0) {
        shares[i] += diff;
        break;
      }
    }
  }

  // ── 3. Tax per line (after discounts), inclusive or exclusive
  const lines: CalcLineResult[] = pre.map((p, i) => {
    const headerShare = shares[i];
    const net = p.netBeforeHeader - headerShare;
    const rate = p.taxRatePct;
    let taxable: number;
    let tax: number;
    let total: number;
    if (mode === 'INCLUSIVE') {
      taxable = rate > 0 ? r((net * 100) / (100 + rate)) : net;
      tax = net - taxable;
      total = net; // tax already inside the price
    } else {
      taxable = net;
      tax = rate > 0 ? r((net * rate) / 100) : 0;
      total = net + tax;
    }
    return {
      grossFils: p.gross,
      lineDiscountFils: p.lineDiscount,
      netBeforeHeaderFils: p.netBeforeHeader,
      headerShareFils: headerShare,
      netFils: net,
      taxableFils: taxable,
      taxFils: tax,
      totalFils: total,
    };
  });

  const totalNetFils = lines.reduce((s, l) => s + l.taxableFils, 0);
  const totalTaxFils = lines.reduce((s, l) => s + l.taxFils, 0);
  const grandTotalFils = lines.reduce((s, l) => s + l.totalFils, 0);
  const totalLineDiscountFils = lines.reduce((s, l) => s + l.lineDiscountFils, 0);

  return {
    lines,
    totalNetFils,
    totalTaxFils,
    grandTotalFils,
    totalLineDiscountFils,
    headerDiscountFils: headerDisc,
    totalDiscountFils: totalLineDiscountFils + headerDisc,
  };
}

/** JOD major (number/string) → integer fils. */
export function toFils(jod: number | string | null | undefined): number {
  const n = typeof jod === 'string' ? parseFloat(jod) : jod;
  return Math.round((Number.isFinite(n as number) ? (n as number) : 0) * 1000);
}

/** Integer fils → JOD major string with 3 decimals. */
export function filsToJod(fils: number): string {
  return (fils / 1000).toFixed(3);
}
