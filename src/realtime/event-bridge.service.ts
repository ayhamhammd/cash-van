import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { EventsGateway } from './events.gateway';
import { SYNC_REQUIRED_EVENT, SyncResource, syncSignal } from './sync-signal';

/**
 * Forwards internal EventEmitter2 domain events to WebSocket clients.
 *
 * Each handler maps a domain event to the spec's WS event name + payload shape.
 * Sources that don't exist yet (anomaly/cheque-scan from plan 08) simply won't
 * fire until those plans emit — the wiring is ready.
 */
/**
 * Pull a rep id out of a loosely-typed event payload.
 *
 * Returns null when there is no usable one — which routes the event to
 * unrestricted dashboards only. An approval filed from the office carries no
 * repId, and that is exactly the case no scoped supervisor should be pinged for.
 */
function repIdOf(p: Record<string, unknown>): string | null {
  const v = p.repId ?? p.rep_id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

@Injectable()
export class EventBridgeService {
  constructor(private readonly gateway: EventsGateway) {}

  // ---- Salesman data signals ------------------------------------------------
  //
  // Targeted at the van(s) that actually care. The dashboard broadcast below is
  // unchanged; these are the only handlers that use rooms.

  /**
   * Offers changed anywhere (dashboard edit, ERP pull, schedule flip).
   *
   * Goes to EVERY rep, not to a subset. Eligibility is evaluated per customer at
   * sell time — segment, new-only, payment method — so there is no reliable way
   * to say in advance which vans an offer will matter to. Narrowing this would
   * mean a rep quoting a price the server then refuses to honour.
   */
  @OnEvent('offers.changed')
  onOffersChanged(p: { reason?: string } = {}): void {
    this.gateway.emitToAllReps(
      SYNC_REQUIRED_EVENT,
      syncSignal('offers', p.reason ?? 'offers.changed'),
    );
  }

  /**
   * A customer was created, edited or reassigned.
   *
   * Sent to the owning rep. On reassignment BOTH reps are signalled — the new
   * owner to pick the customer up, the previous owner to drop it — otherwise the
   * old van keeps selling to a customer it no longer holds.
   */
  @OnEvent('customer.changed')
  onCustomerChanged(p: {
    repId?: string | null;
    previousRepId?: string | null;
    reason?: string;
  } = {}): void {
    const signal = syncSignal('customers', p.reason ?? 'customer.changed');
    const targets = new Set([p.repId, p.previousRepId].filter(Boolean));
    if (targets.size === 0) {
      // No rep named — a bulk ERP pull that touched who-knows-whose customers.
      // Tell every van rather than silently telling none.
      this.gateway.emitToAllReps(SYNC_REQUIRED_EVENT, signal);
      return;
    }
    for (const repId of targets) {
      this.gateway.emitToRep(repId as string, SYNC_REQUIRED_EVENT, signal);
    }
  }

  /**
   * The catalogue changed — a product's price, name, barcode or units, or a
   * product appearing or disappearing (an ERP pull, a dashboard edit).
   *
   * Goes to every rep: an item is not owned by one van, and the emitters upstream
   * only fire when a row genuinely changed, so this is not chatty. The app
   * responds by re-pulling products, which a `stock` signal does NOT do — that one
   * writes quantities onto rows the device already holds.
   */
  @OnEvent('items.changed')
  onItemsChanged(p: { reason?: string } = {}): void {
    this.gateway.emitToAllReps(
      SYNC_REQUIRED_EVENT,
      syncSignal('items', p.reason ?? 'items.changed'),
    );
  }

  /** A van's stock moved from outside the app (load, return, ERP correction). */
  @OnEvent('stock.changed')
  onStockChanged(p: { repId?: string | null; reason?: string }): void {
    const signal = syncSignal('stock', p.reason ?? 'stock.changed');
    if (p.repId) {
      this.gateway.emitToRep(p.repId, SYNC_REQUIRED_EVENT, signal);
      return;
    }
    // No rep named — an ERP-wide stock refresh. Tell everyone rather than
    // guessing, since a silent stale van oversells.
    this.gateway.emitToAllReps(SYNC_REQUIRED_EVENT, signal);
  }

  /**
   * A voucher posted — a sale, a transfer, a van load or a return. Any of these
   * moves stock on some van, so tell every van to refresh its own stock in real
   * time. The payload names only the kind, not the rep, so this fans out to all
   * vans; each pulls a small ledger and the ones it didn't touch simply no-op.
   * This is what makes a van's qty reflect a transfer/sale without waiting for a
   * poll — the same signal the ERP-driven and manual paths already use.
   */
  @OnEvent('erp.voucher.posted')
  onVoucherPosted(p: { transKind?: string } = {}): void {
    this.gateway.emitToAllReps(
      SYNC_REQUIRED_EVENT,
      syncSignal('stock', `voucher.posted:${p.transKind ?? 'unknown'}`),
    );
  }

  /** Escape hatch for callers that already know the resource. */
  signalRep(repId: string, resource: SyncResource, reason: string): void {
    this.gateway.emitToRep(repId, SYNC_REQUIRED_EVENT, syncSignal(resource, reason));
  }

  @OnEvent('rep.location')
  onRepLocation(p: { repId: string; lat: number; lng: number; recordedAt: Date }): void {
    this.gateway.broadcastForRep('rep.location', {
      rep_id: p.repId,
      lat: p.lat,
      lng: p.lng,
      ts: p.recordedAt,
    }, p.repId);
  }

  @OnEvent('invoice.created')
  onInvoiceCreated(p: { invoiceId: string; repId: string }): void {
    this.gateway.broadcastForRep('invoice.created', {
      invoice_id: p.invoiceId,
      rep_id: p.repId,
    }, p.repId);
  }

  @OnEvent('invoice.confirmed')
  onInvoiceConfirmed(p: {
    invoiceId: string;
    repId: string;
    customerId: string;
    grandTotal: number;
  }): void {
    this.gateway.broadcastForRep('invoice.confirmed', {
      invoice_id: p.invoiceId,
      rep_id: p.repId,
      customer_id: p.customerId,
      total: p.grandTotal,
    }, p.repId);
  }

  @OnEvent('route.deviated')
  onRouteDeviated(p: {
    repId: string;
    planId: string;
    nearestStopMeters: number;
  }): void {
    this.gateway.broadcastForRep('route.deviated', {
      rep_id: p.repId,
      plan_id: p.planId,
      deviation_m: p.nearestStopMeters,
    }, p.repId);
  }

  @OnEvent('rep.offline')
  onRepOffline(p: { repId: string; lastSeen: Date | null }): void {
    this.gateway.broadcastForRep('rep.offline', {
      rep_id: p.repId,
      last_seen: p.lastSeen,
    }, p.repId);
  }

  @OnEvent('rep.online')
  onRepOnline(p: { repId: string; at: Date }): void {
    this.gateway.broadcastForRep('rep.online', { rep_id: p.repId, ts: p.at }, p.repId);
  }

  @OnEvent('rep.gps_off')
  onRepGpsOff(p: { repId: string; at: Date }): void {
    this.gateway.broadcastForRep('rep.gps_off', { rep_id: p.repId, ts: p.at }, p.repId);
  }

  @OnEvent('rep.gps_on')
  onRepGpsOn(p: { repId: string; at: Date }): void {
    this.gateway.broadcastForRep('rep.gps_on', { rep_id: p.repId, ts: p.at }, p.repId);
  }

  @OnEvent('rep.app_closed')
  onRepAppClosed(p: { repId: string; at: Date }): void {
    this.gateway.broadcastForRep('rep.app_closed', { rep_id: p.repId, ts: p.at }, p.repId);
  }

  // Reserved for plan 08:
  @OnEvent('anomaly.flagged')
  onAnomaly(p: Record<string, unknown>): void {
    this.gateway.broadcastForRep('anomaly.flagged', p, repIdOf(p));
  }

  @OnEvent('cheque.scanned')
  onChequeScanned(p: Record<string, unknown>): void {
    this.gateway.broadcast('cheque.scanned', p);
  }

  // F10 — approvals + notification inbox
  @OnEvent('approval.requested')
  onApprovalRequested(p: Record<string, unknown>): void {
    this.gateway.broadcastForRep('approval.requested', p, repIdOf(p));
  }

  @OnEvent('approval.decided')
  onApprovalDecided(p: Record<string, unknown>): void {
    this.gateway.broadcastForRep('approval.decided', p, repIdOf(p));
  }

  @OnEvent('notification.created')
  onNotificationCreated(p: Record<string, unknown>): void {
    this.gateway.broadcast('notification.created', p);
  }

  // Van stock requests. Scoped like approvals: a supervisor sees requests from
  // their own salesmen and no one else's.
  @OnEvent('stock-request.requested')
  onStockRequested(p: Record<string, unknown>): void {
    this.gateway.broadcastForRep('stock-request.requested', p, repIdOf(p));
  }

  @OnEvent('stock-request.decided')
  onStockDecided(p: Record<string, unknown>): void {
    this.gateway.broadcastForRep('stock-request.decided', p, repIdOf(p));
    // The salesman is waiting on this specific answer, so it also goes straight
    // to their device rather than only to the dashboards watching them.
    const repId = repIdOf(p);
    if (repId) this.gateway.emitToRep(repId, 'stock-request.decided', p);
  }

  @OnEvent('stock-request.received')
  onStockReceived(p: Record<string, unknown>): void {
    this.gateway.broadcastForRep('stock-request.received', p, repIdOf(p));
  }
}
