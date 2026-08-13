/**
 * The "your data changed, come and get it" signal pushed to the salesman app.
 *
 * ## Why a hint and not the data
 *
 * The socket carries a *pointer*, never the changed rows. The app reacts by
 * pulling through its normal sync endpoints — the same path it uses on
 * foreground and on the home screen today.
 *
 * That is deliberate:
 *
 *   - **Offline is the normal state.** A van loses signal constantly. Pushed
 *     payloads would arrive in gaps, out of order, or not at all, and the device
 *     would have no way to tell a stale push from a fresh one.
 *   - **One reconciliation path.** Pull already handles conflicts, deletions and
 *     partial failures. A second, push-shaped path would need all of that again
 *     and would drift from it.
 *   - **A missed signal is harmless.** It costs freshness, not correctness: the
 *     next foreground pull catches up. Nothing is queued server-side, so a rep
 *     who was asleep for an hour does not wake to a backlog of stale nudges.
 *
 * Payloads are therefore tiny and idempotent — receiving the same one twice must
 * be indistinguishable from receiving it once.
 */

/** Socket event name the app subscribes to. */
export const SYNC_REQUIRED_EVENT = 'sync.required';

/** Which slice of the app's local data went stale. */
export type SyncResource = 'offers' | 'customers' | 'stock';

export interface SyncSignal {
  resource: SyncResource;
  /**
   * Why it changed, for the app's log and for support calls — never for
   * branching. The app's response to any signal is the same: pull that resource.
   */
  reason: string;
  /** Server time the change landed (ISO), for ordering and diagnostics. */
  at: string;
}

export function syncSignal(resource: SyncResource, reason: string): SyncSignal {
  return { resource, reason, at: new Date().toISOString() };
}
