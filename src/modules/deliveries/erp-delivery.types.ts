/**
 * The ERP's v1 delivery-runs API, as this backend reads it
 * (delivery phase-1 contract §A).
 *
 * Read the way erp-sync reads `sales-invoices`:
 *  - a list is `{ success, data: [...], pagination: { total, ... } }`;
 *  - one object is `{ success, data: {...} }` — a bare object is accepted too;
 *  - money is in MAJOR units (a number, or a numeric string), scaled to fils
 *    once on the way in with erp-sync's `toFils`;
 *  - dates are ISO strings; `runDate` is YYYY-MM-DD;
 *  - an error is `{ success: false, error: { code, message, details? } }`, read
 *    tolerantly (see erpErrorCode).
 */

export type ErpMoney = number | string | null | undefined;

export interface ErpDeliveryLine {
  id: string;
  lineNo?: number | null;
  skuCode?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  unit?: string | null;
  quantity?: number | string | null;
  quantityReturned?: number | string | null;
  unitPrice?: ErpMoney;
  taxRate?: number | string | null;
  lineTotal?: ErpMoney;
}

export interface ErpDeliveryInvoice {
  id?: string | null;
  invoiceNumber?: string | null;
  issueDate?: string | null;
  status?: string | null;
  customerId?: string | null;
  customerCode?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  totalAmount?: ErpMoney;
  taxAmount?: ErpMoney;
  amountPaid?: ErpMoney;
  paymentType?: string | null;
  jofotaraStatus?: string | null;
  jofotaraQrCode?: string | null;
  jofotaraUuid?: string | null;
  lines?: ErpDeliveryLine[] | null;
}

/** One line the ERP recorded as different (phase 2). Lines not listed were delivered in full. */
export interface ErpLineResult {
  invoiceItemId: string;
  lineNo?: number | null;
  invoicedQty?: number | string | null;
  deliveredQty?: number | string | null;
  reasonCode?: string | null;
  condition?: string | null;
  note?: string | null;
  approvedQty?: number | string | null;
}

export interface ErpAttachmentRef {
  id: string;
  role?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  createdAt?: string | null;
}

/** The credit note an approved return issued (phase 3). Money in major units. */
export interface ErpCreditNote {
  id?: string | null;
  number?: string | null;
  total?: ErpMoney;
  taxTotal?: ErpMoney;
  jofotara?: { status?: string | null; qrCode?: string | null; uuid?: string | null } | null;
}

export interface ErpDeliveryItem {
  id: string;
  /** Who decided the return: a name, or `{ id, name }`. */
  returnDecidedBy?: string | { id?: string | null; name?: string | null } | null;
  returnDecidedAt?: string | null;
  returnDecisionNote?: string | null;
  creditNote?: ErpCreditNote | null;
  /** NONE | PENDING | APPROVED | REJECTED (phase 2). */
  returnStatus?: string | null;
  results?: ErpLineResult[] | null;
  attachments?: ErpAttachmentRef[] | null;
  sequence?: number | null;
  status?: string | null;
  deliveredAt?: string | null;
  notes?: string | null;
  signedByName?: string | null;
  deliveredLat?: number | string | null;
  deliveredLng?: number | string | null;
  resultSource?: string | null;
  resultExternalRef?: string | null;
  invoice?: ErpDeliveryInvoice | null;
}

export interface ErpDeliveryRun {
  id: string;
  runNumber?: string | null;
  runDate?: string | null;
  status?: string | null;
  notes?: string | null;
  updatedAt?: string | null;
  openedAt?: string | null;
  closedAt?: string | null;
  driver?: {
    type?: string | null;
    salesmanId?: string | null;
    salesmanCode?: string | null;
    userId?: string | null;
    name?: string | null;
  } | null;
  vehicle?: { id?: string | null; name?: string | null; plateNumber?: string | null } | null;
  items?: ErpDeliveryItem[] | null;
}

/** `POST /api/v1/attachments` answer: `{ success, data: { id, role, mimeType, sizeBytes, createdAt } }`. */
export function attachmentIdOf(body: unknown): string | null {
  const top = obj(body);
  if (!top) return null;
  const d = obj(top.data) ?? top;
  return typeof d.id === 'string' || typeof d.id === 'number' ? String(d.id) : null;
}

/** `POST delivery-returns/{itemId}/approve|reject` answer: `{ data: { item, creditNote? } }`. */
export function unwrapDecision(body: unknown): { item: ErpDeliveryItem | null; creditNote: ErpCreditNote | null } {
  const top = obj(body);
  const d = (top && obj(top.data)) ?? top;
  const item = d ? obj(d.item) : null;
  const cn = d ? obj(d.creditNote) : null;
  return {
    item: item && item.id != null ? ({ ...item, id: String(item.id) } as unknown as ErpDeliveryItem) : null,
    creditNote: (cn as ErpCreditNote | null) ?? ((item?.creditNote as ErpCreditNote | null) ?? null),
  };
}

export interface ErpVehicle {
  id: string;
  name?: string | null;
  plateNumber?: string | null;
}

export interface ErpLoadRefusal {
  invoiceNumber: string;
  reason: string;
}

export interface ErpLoadWarning {
  invoiceNumber: string;
  code: string;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `{ data: run }` or the run itself; null when the body carries no run. */
export function unwrapRun(body: unknown): ErpDeliveryRun | null {
  const top = obj(body);
  if (!top) return null;
  const d = obj(top.data) ?? top;
  return typeof d.id === 'string' || typeof d.id === 'number'
    ? ({ ...d, id: String(d.id) } as unknown as ErpDeliveryRun)
    : null;
}

/** `{ data: [...] }`, `{ items: [...] }` or a bare array. */
export function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const top = obj(body);
  if (!top) return [];
  if (Array.isArray(top.data)) return top.data as T[];
  if (Array.isArray(top.items)) return top.items as T[];
  return [];
}

/**
 * The ERP's machine code, wherever it put it:
 * `body.code ?? body.error?.code ?? (typeof body.error === 'string' ? body.error : undefined)`.
 */
export function erpErrorCode(body: unknown): string | undefined {
  const b = obj(body);
  if (!b) return undefined;
  if (typeof b.code === 'string') return b.code;
  const e = obj(b.error);
  if (e && typeof e.code === 'string') return e.code;
  if (typeof b.error === 'string') return b.error;
  return undefined;
}

/** The human message the ERP attached to a refusal, when there is one. */
export function erpErrorMessage(body: unknown): string | undefined {
  const b = obj(body);
  if (!b) return undefined;
  const e = obj(b.error);
  if (e && typeof e.message === 'string') return e.message;
  if (typeof b.message === 'string') return b.message;
  return undefined;
}

function isRefusal(v: unknown): v is ErpLoadRefusal {
  const o = obj(v);
  return !!o && typeof o.invoiceNumber === 'string';
}

/**
 * The per-invoice refusals of a LOAD_REFUSED: top-level `refusals`, or inside
 * `error` (`error.refusals`, or `error.details` when that is the list).
 */
export function erpRefusals(body: unknown): ErpLoadRefusal[] {
  const b = obj(body);
  if (!b) return [];
  const e = obj(b.error);
  const d = obj(b.data);
  const candidates: unknown[] = [b.refusals, e?.refusals, obj(e?.details)?.refusals, e?.details, d?.refusals];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length && c.every(isRefusal)) {
      return c.map((r) => ({ invoiceNumber: r.invoiceNumber, reason: String(r.reason ?? 'UNKNOWN') }));
    }
  }
  return [];
}

/** `warnings: [{ invoiceNumber, code }]` of a create, at the top or inside `data`. */
export function erpWarnings(body: unknown): ErpLoadWarning[] {
  const b = obj(body);
  if (!b) return [];
  const list = Array.isArray(b.warnings) ? b.warnings : Array.isArray(obj(b.data)?.warnings) ? (obj(b.data)!.warnings as unknown[]) : [];
  return list
    .map((w) => obj(w))
    .filter((w): w is Record<string, unknown> => !!w && typeof w.invoiceNumber === 'string')
    .map((w) => ({ invoiceNumber: String(w.invoiceNumber), code: String(w.code ?? 'WARNING') }));
}
