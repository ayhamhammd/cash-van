import type { DeliveryProofKind } from './entities/delivery-proof.entity';
import type { ReasonCode } from './delivery-reasons';

/**
 * The checks on a phone's result (delivery phase-2 contract §0 and §B). Pure,
 * so every rule is pinned by a spec without a database.
 */

export type ResultOutcome = 'DELIVERED' | 'PARTIAL' | 'RETURNED';

export type RejectReason =
  | 'PROOF_MISSING'
  | 'PROOF_UNKNOWN'
  | 'OUTCOME_MISMATCH'
  | 'QTY_OUT_OF_RANGE'
  | 'REASON_REQUIRED'
  | 'NOTE_REQUIRED'
  | 'LINE_UNKNOWN';

/** A line of the stop as the mirror holds it. */
export interface StopLineRef {
  erpInvoiceItemId: string;
  /** Invoice quantity less what was already returned on the line. */
  invoicedQty: number;
}

export interface SentLine {
  erpInvoiceItemId: string;
  deliveredQty: number;
  reasonCode?: ReasonCode | null;
  note?: string | null;
}

/** Each stop line's result as the ERP will record it. */
export interface EffectiveLine {
  erpInvoiceItemId: string;
  invoicedQty: number;
  deliveredQty: number;
  reasonCode: ReasonCode | null;
  note: string | null;
  differs: boolean;
}

/** Quantities are decimals (weight units): compare with a tolerance. */
const EPS = 1e-9;

/**
 * Check the lines against the stop and the outcome against the lines.
 *
 *  - a line the stop does not have, or the same line twice → LINE_UNKNOWN;
 *  - 0 ≤ deliveredQty ≤ invoicedQty, else QTY_OUT_OF_RANGE;
 *  - a line sent short needs a reason (REASON_REQUIRED), OTHER also a note
 *    (NOTE_REQUIRED);
 *  - lines left out were delivered in full, except that RETURNED with no lines
 *    delivered nothing;
 *  - every line in full → DELIVERED, every line at 0 → RETURNED, else PARTIAL;
 *    anything else → OUTCOME_MISMATCH.
 */
export function checkLines(
  stopLines: StopLineRef[],
  outcome: ResultOutcome,
  sent: SentLine[] | undefined,
): { ok: true; lines: EffectiveLine[]; differing: number } | { ok: false; reason: RejectReason } {
  const byId = new Map(stopLines.map((l) => [l.erpInvoiceItemId, l]));
  const given = new Map<string, SentLine>();
  for (const l of sent ?? []) {
    if (!byId.has(l.erpInvoiceItemId) || given.has(l.erpInvoiceItemId)) {
      return { ok: false, reason: 'LINE_UNKNOWN' };
    }
    given.set(l.erpInvoiceItemId, l);
  }
  for (const l of given.values()) {
    const invoiced = byId.get(l.erpInvoiceItemId)!.invoicedQty;
    if (!Number.isFinite(l.deliveredQty) || l.deliveredQty < -EPS || l.deliveredQty > invoiced + EPS) {
      return { ok: false, reason: 'QTY_OUT_OF_RANGE' };
    }
    if (l.deliveredQty < invoiced - EPS) {
      if (!l.reasonCode) return { ok: false, reason: 'REASON_REQUIRED' };
      if (l.reasonCode === 'OTHER' && !l.note?.trim()) return { ok: false, reason: 'NOTE_REQUIRED' };
    }
  }

  const wholeRefusal = outcome === 'RETURNED' && given.size === 0;
  const lines: EffectiveLine[] = stopLines.map((l) => {
    const g = given.get(l.erpInvoiceItemId);
    const deliveredQty = g ? g.deliveredQty : wholeRefusal ? 0 : l.invoicedQty;
    return {
      erpInvoiceItemId: l.erpInvoiceItemId,
      invoicedQty: l.invoicedQty,
      deliveredQty,
      reasonCode: g?.reasonCode ?? null,
      note: g?.note?.trim() || null,
      differs: deliveredQty < l.invoicedQty - EPS,
    };
  });

  const allFull = lines.every((l) => !l.differs);
  const allZero = lines.every((l) => l.deliveredQty <= EPS);
  const fits =
    outcome === 'DELIVERED' ? allFull : outcome === 'RETURNED' ? allZero : !allFull && !allZero;
  if (!fits) return { ok: false, reason: 'OUTCOME_MISMATCH' };
  return { ok: true, lines, differing: lines.filter((l) => l.differs).length };
}

/**
 * Check the proofs a result names.
 *
 *  - every proofRef must be a proof already uploaded for THIS stop
 *    (PROOF_UNKNOWN);
 *  - with proofs required: DELIVERED / PARTIAL need ≥1 PHOTO and exactly one
 *    SIGNATURE, RETURNED ≥1 PHOTO (PROOF_MISSING).
 */
export function checkProofs(
  required: boolean,
  outcome: ResultOutcome,
  refs: string[],
  uploaded: Array<{ clientRef: string; kind: DeliveryProofKind }>,
): RejectReason | null {
  const byRef = new Map(uploaded.map((p) => [p.clientRef, p]));
  const unique = [...new Set(refs)];
  if (unique.some((r) => !byRef.has(r))) return 'PROOF_UNKNOWN';
  if (!required) return null;
  const photos = unique.filter((r) => byRef.get(r)!.kind === 'PHOTO').length;
  const signatures = unique.filter((r) => byRef.get(r)!.kind === 'SIGNATURE').length;
  if (outcome === 'RETURNED') return photos >= 1 ? null : 'PROOF_MISSING';
  return photos >= 1 && signatures === 1 ? null : 'PROOF_MISSING';
}
