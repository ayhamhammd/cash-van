/**
 * Why a staged document did not post — and therefore whether to try again.
 *
 * Every promotion failure used to be treated alike: the row went to `failed`
 * and waited for a human who had no reason to look. But the two kinds need
 * opposite handling, and conflating them is what left real sales sitting in an
 * inbox nobody read.
 *
 *   retryable — the prerequisite may still arrive. A sale promoted ahead of the
 *               TRANSFER that loads the van, a line for an item the catalogue
 *               sync has not landed yet. Back off and try again; the queue
 *               resolves itself and no one is interrupted.
 *
 *   terminal  — no number of retries changes the answer. A customer over their
 *               credit limit, a rep outside the geofence, a return they may not
 *               file, a voucher number already taken. A person must act, so say
 *               so immediately instead of burning eight attempts first.
 *
 * `ErpOutboxService` learned this distinction the expensive way — see
 * `TerminalPayloadError` and the note about ORD-101000002 burning six attempts
 * on a condition that could not change. This is the same idea on the intake
 * side, classified from the exceptions the voucher and collection services
 * actually throw rather than from HTTP status alone: a 409 is terminal when it
 * is a credit limit and retryable when it is stock.
 */
export type IntakeFailureClass = 'retryable' | 'terminal';

/** Codes that mean "a person must decide", whatever the HTTP status. */
const TERMINAL_CODES = new Set([
  'CREDIT_HOLD',
  'CREDIT_LIMIT_EXCEEDED',
  'outside_customer_geofence',
]);

/** Codes that mean "a prerequisite has not synced yet". */
const RETRYABLE_CODES = new Set(['INSUFFICIENT_STOCK']);

const TERMINAL_PATTERNS = [
  // enforceSalesmanPolicy — the rep needs an approval or lacks the permission.
  /APPROVAL_REQUIRED:/i,
  /RETURN_NOT_ALLOWED/i,
  /DISCOUNT_NOT_ALLOWED/i,
  // The number is taken. Retrying replays the same collision forever; the
  // document needs renumbering by someone who can confirm it is not a duplicate.
  /already exists/i,
  // A payload no retry can repair.
  /must be/i,
  /is required/i,
  /اختر العميل/,
];

const RETRYABLE_PATTERNS = [
  // The ledger guard in createUnchecked. A load TRANSFER may still be queued
  // behind this sale — which is the ordinary shape of an offline batch.
  /Not enough stock/i,
  // Catalogue rows the ERP sync has not delivered yet.
  /not found/i,
];

interface ErrorShape {
  message?: string;
  response?: { code?: string; message?: string } | string;
}

/**
 * Classify a promotion failure. Unknown failures are **retryable**: an
 * unrecognised error is more likely a transient fault (a dropped connection, a
 * deadlock, the ERP briefly unreachable) than a permanent refusal, and
 * `MAX_ATTEMPTS` bounds the cost of being wrong. Guessing `terminal` would
 * discard a recoverable sale on the first stumble.
 */
export function classifyIntakeFailure(e: unknown): IntakeFailureClass {
  const err = (e ?? {}) as ErrorShape;
  const response = typeof err.response === 'object' ? err.response : undefined;

  const code = response?.code;
  if (code && TERMINAL_CODES.has(code)) return 'terminal';
  if (code && RETRYABLE_CODES.has(code)) return 'retryable';

  const text = [
    err.message,
    typeof err.response === 'string' ? err.response : response?.message,
  ]
    .filter(Boolean)
    .join(' ');

  // Retryable patterns are tested FIRST: "Item unit X not found" must not be
  // caught by the /is required/ terminal pattern, and a stock shortfall must
  // never read as a validation error.
  if (RETRYABLE_PATTERNS.some((re) => re.test(text))) return 'retryable';
  if (TERMINAL_PATTERNS.some((re) => re.test(text))) return 'terminal';
  return 'retryable';
}

/**
 * Backoff between promotion attempts, indexed by attempts already made.
 *
 * Front-loaded, because the common retryable case — a sale promoted just ahead
 * of the transfer that stocks the van — resolves within seconds. The long tail
 * covers a catalogue row that will not arrive until the next ERP sweep.
 */
export const INTAKE_BACKOFF_MS = [
  30_000, // 30s
  120_000, // 2m
  600_000, // 10m
  1_800_000, // 30m
  7_200_000, // 2h
  21_600_000, // 6h
  43_200_000, // 12h
  86_400_000, // 24h
];

export const INTAKE_MAX_ATTEMPTS = INTAKE_BACKOFF_MS.length;

export function intakeBackoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 0), INTAKE_BACKOFF_MS.length - 1);
  return INTAKE_BACKOFF_MS[i];
}
