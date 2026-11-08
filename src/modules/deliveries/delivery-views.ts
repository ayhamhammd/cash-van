import type { DeliveryRun } from './entities/delivery-run.entity';
import type { DeliveryStop, DeliveryStopStatus } from './entities/delivery-stop.entity';
import type { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import type { DeliveryProof } from './entities/delivery-proof.entity';
import { conditionOf } from './delivery-reasons';

/** The answer shapes of contract §B "Types". Money is fils (numbers). */

export interface CustomerRef {
  id: string;
  customerNumber: string;
  name: string;
  placeLabel: string | null;
}

export interface RepRef {
  id: string;
  code: string | null;
  nameAr: string;
  nameEn: string | null;
}

export interface LineView {
  id: string;
  erpInvoiceItemId: string;
  lineNo: number | null;
  skuCode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  unit: string | null;
  invoicedQty: number;
  unitPriceFils: number;
  taxRate: number | null;
  deliveredQty: number | null;
  reasonCode: string | null;
  /** GOOD | DAMAGED — from the reason. */
  condition: string | null;
  note: string | null;
}

export interface ProofView {
  id: string;
  kind: DeliveryProof['kind'];
  mime: string;
  sizeBytes: number;
  capturedAt: string | null;
  /** Streams the file: the dashboard's or the phone's route, by who is asking. */
  url: string;
}

/** Who the answer is for — decides which proof route the urls point at. */
export type ProofAudience = 'dashboard' | 'phone';

/** Path from the site root, so an `<img src>` works with the session cookie. */
export function proofUrl(audience: ProofAudience, stopId: string, proofId: string): string {
  return audience === 'phone'
    ? `/api/v1/deliveries/my-stops/${stopId}/proofs/${proofId}`
    : `/api/v1/deliveries/stops/${stopId}/proofs/${proofId}`;
}

export interface GoodsBackRow {
  skuCode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  unit: string | null;
  qty: number;
}

export type DisplayStatus = DeliveryStopStatus | 'SENDING';

export interface StopView {
  id: string;
  erpId: string;
  sequence: number;
  invoiceNumber: string | null;
  erpInvoiceId: string | null;
  invoiceDate: string | null;
  customer: CustomerRef | null;
  erpCustomerId: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  address: string | null;
  totalFils: number;
  taxFils: number;
  paidFils: number;
  paymentType: string | null;
  jofotaraStatus: string | null;
  jofotaraQr: string | null;
  status: DeliveryStopStatus;
  displayStatus: DisplayStatus;
  deliveredAt: string | null;
  signedByName: string | null;
  lat: number | null;
  lng: number | null;
  returnStatus: DeliveryStop['returnStatus'];
  creditNoteNumber: string | null;
  collectedFils: number;
  lines: LineView[];
  proofs: ProofView[];
  /** ERP attachments on the stop that are not one of these proofs (added in the ERP). */
  erpOnlyAttachments: number;
}

export interface RunSummaryView {
  id: string;
  erpId: string;
  runNumber: string | null;
  runDate: string | null;
  status: DeliveryRun['status'];
  notes: string | null;
  rep: RepRef | null;
  driverCode: string | null;
  vehicleName: string | null;
  stopsTotal: number;
  counts: { loaded: number; delivered: number; partial: number; returned: number; sending: number };
  collectedFils: number;
  returns: { pending: number; approved: number; rejected: number };
}

export interface RunDetailView extends RunSummaryView {
  stops: StopView[];
  /** Goods coming back on this run: invoiced − delivered over its finished stops, by item. */
  goodsBack?: GoodsBackRow[];
}

const n = (v: string | number | null | undefined): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const nOrNull = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined || v === '' ? null : n(v);
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** SENDING while a phone result is in flight, else the ERP's status. */
export function displayStatusOf(stop: Pick<DeliveryStop, 'status' | 'localResultRef'>): DisplayStatus {
  return stop.localResultRef ? 'SENDING' : stop.status;
}

/**
 * One line. While the stop's result is in flight the phone's own figures are
 * shown (the ERP still has none), so the office sees the difference at once.
 */
export function lineView(l: DeliveryStopLine, sending = false): LineView {
  const reasonCode = sending ? (l.localReasonCode ?? null) : (l.reasonCode ?? null);
  return {
    id: l.id,
    erpInvoiceItemId: l.erpInvoiceItemId,
    lineNo: l.lineNo ?? null,
    skuCode: l.skuCode ?? null,
    nameAr: l.nameAr ?? null,
    nameEn: l.nameEn ?? null,
    unit: l.unit ?? null,
    invoicedQty: n(l.invoicedQty),
    unitPriceFils: n(l.unitPriceFils),
    taxRate: nOrNull(l.taxRate),
    deliveredQty: nOrNull(sending ? l.localDeliveredQty : l.deliveredQty),
    reasonCode,
    condition: sending ? conditionOf(reasonCode) : (l.condition ?? conditionOf(reasonCode)),
    note: sending ? (l.localNote ?? null) : (l.note ?? null),
  };
}

export function proofView(p: DeliveryProof, audience: ProofAudience): ProofView {
  return {
    id: p.id,
    kind: p.kind,
    mime: p.mime,
    sizeBytes: p.sizeBytes,
    capturedAt: iso(p.capturedAt),
    url: proofUrl(audience, p.stopId, p.id),
  };
}

/** A line came back short. */
export function lineDiffers(l: Pick<LineView, 'invoicedQty' | 'deliveredQty'>): boolean {
  return l.deliveredQty !== null && l.deliveredQty < l.invoicedQty - 1e-9;
}

/**
 * One stop as the dashboard and the phone see it. While the phone's result is
 * in flight the ERP still says LOADED; the delivery time, signer and position
 * then come from the phone's own copy so the office sees what happened.
 */
export function stopView(
  s: DeliveryStop,
  lines: DeliveryStopLine[],
  customer: CustomerRef | null,
  collectedFils: number,
  proofs: DeliveryProof[] = [],
  audience: ProofAudience = 'dashboard',
): StopView {
  const sending = !!s.localResultRef;
  const lineViews = [...lines]
    .sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0))
    .map((l) => lineView(l, sending));
  return {
    id: s.id,
    erpId: s.erpId,
    sequence: s.sequence,
    invoiceNumber: s.invoiceNumber ?? null,
    erpInvoiceId: s.erpInvoiceId ?? null,
    invoiceDate: iso(s.invoiceDate),
    customer,
    erpCustomerId: s.erpCustomerId ?? null,
    recipientName: s.recipientName ?? null,
    recipientPhone: s.recipientPhone ?? null,
    address: s.address ?? null,
    totalFils: n(s.totalFils),
    taxFils: n(s.taxFils),
    paidFils: n(s.paidFils),
    paymentType: s.paymentType ?? null,
    jofotaraStatus: s.jofotaraStatus ?? null,
    jofotaraQr: s.jofotaraQr ?? null,
    status: s.status,
    displayStatus: displayStatusOf(s),
    deliveredAt: iso(s.deliveredAt ?? (sending ? s.localDeliveredAt : null)),
    signedByName: s.signedByName ?? (sending ? (s.localSignedBy ?? null) : null),
    lat: nOrNull(s.lat ?? (sending ? s.localLat : null)),
    lng: nOrNull(s.lng ?? (sending ? s.localLng : null)),
    // A difference sent from the phone is a return request the moment it lands;
    // the ERP will say PENDING too once it has the result.
    returnStatus:
      sending && s.returnStatus === 'NONE' && lineViews.some(lineDiffers) ? 'PENDING' : s.returnStatus,
    creditNoteNumber: s.creditNoteNumber ?? null,
    collectedFils,
    lines: lineViews,
    proofs: [...proofs]
      .sort((a, b) => (a.kind === b.kind ? +a.createdAt - +b.createdAt : a.kind === 'PHOTO' ? -1 : 1))
      .map((p) => proofView(p, audience)),
    erpOnlyAttachments: s.erpOnlyAttachments ?? 0,
  };
}

/**
 * Goods coming back on a run: for every finished stop (or one being sent),
 * invoiced − delivered, summed by item and unit. A stop still LOADED is not
 * counted — nothing has come back from it yet.
 */
export function goodsBack(stops: StopView[]): GoodsBackRow[] {
  const by = new Map<string, GoodsBackRow>();
  for (const s of stops) {
    if (s.displayStatus === 'LOADED') continue;
    for (const l of s.lines) {
      if (!lineDiffers(l)) continue;
      const key = `${l.skuCode ?? l.erpInvoiceItemId}|${l.unit ?? ''}`;
      const row = by.get(key) ?? { skuCode: l.skuCode, nameAr: l.nameAr, nameEn: l.nameEn, unit: l.unit, qty: 0 };
      row.qty = Math.round((row.qty + (l.invoicedQty - (l.deliveredQty ?? 0))) * 1000) / 1000;
      by.set(key, row);
    }
  }
  return [...by.values()].sort((a, b) => String(a.skuCode ?? '').localeCompare(String(b.skuCode ?? '')));
}

/** The run header with its stop counts (by display status) and money collected. */
export function runSummaryView(
  run: DeliveryRun,
  stops: StopView[],
  rep: RepRef | null,
): RunSummaryView {
  const counts = { loaded: 0, delivered: 0, partial: 0, returned: 0, sending: 0 };
  for (const s of stops) {
    if (s.displayStatus === 'SENDING') counts.sending += 1;
    else if (s.displayStatus === 'LOADED') counts.loaded += 1;
    else if (s.displayStatus === 'DELIVERED') counts.delivered += 1;
    else if (s.displayStatus === 'PARTIAL') counts.partial += 1;
    else if (s.displayStatus === 'RETURNED') counts.returned += 1;
  }
  const returns = { pending: 0, approved: 0, rejected: 0 };
  for (const s of stops) {
    if (s.returnStatus === 'PENDING') returns.pending += 1;
    else if (s.returnStatus === 'APPROVED') returns.approved += 1;
    else if (s.returnStatus === 'REJECTED') returns.rejected += 1;
  }
  return {
    id: run.id,
    erpId: run.erpId,
    runNumber: run.runNumber ?? null,
    runDate: run.runDate ?? null,
    status: run.status,
    notes: run.notes ?? null,
    rep,
    driverCode: run.driverCode ?? null,
    vehicleName: run.vehicleName ?? null,
    stopsTotal: stops.length,
    counts,
    collectedFils: stops.reduce((sum, s) => sum + s.collectedFils, 0),
    returns,
  };
}
