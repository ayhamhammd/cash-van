import type { DeliveryRun } from './entities/delivery-run.entity';
import type { DeliveryStop, DeliveryStopStatus } from './entities/delivery-stop.entity';
import type { DeliveryStopLine } from './entities/delivery-stop-line.entity';

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
  note: string | null;
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

export function lineView(l: DeliveryStopLine): LineView {
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
    deliveredQty: nOrNull(l.deliveredQty),
    reasonCode: l.reasonCode ?? null,
    note: l.note ?? null,
  };
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
): StopView {
  const sending = !!s.localResultRef;
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
    returnStatus: s.returnStatus,
    creditNoteNumber: s.creditNoteNumber ?? null,
    collectedFils,
    lines: [...lines]
      .sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0))
      .map(lineView),
  };
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
