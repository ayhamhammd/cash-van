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

  /** Escape hatch for callers that already know the resource. */
  signalRep(repId: string, resource: SyncResource, reason: string): void {
    this.gateway.emitToRep(repId, SYNC_REQUIRED_EVENT, syncSignal(resource, reason));
  }

  @OnEvent('rep.location')
  onRepLocation(p: { repId: string; lat: number; lng: number; recordedAt: Date }): void {
    this.gateway.broadcast('rep.location', {
      rep_id: p.repId,
      lat: p.lat,
      lng: p.lng,
      ts: p.recordedAt,
    });
  }

  @OnEvent('invoice.created')
  onInvoiceCreated(p: { invoiceId: string; repId: string }): void {
    this.gateway.broadcast('invoice.created', {
      invoice_id: p.invoiceId,
      rep_id: p.repId,
    });
  }

  @OnEvent('invoice.confirmed')
  onInvoiceConfirmed(p: {
    invoiceId: string;
    repId: string;
    customerId: string;
    grandTotal: number;
  }): void {
    this.gateway.broadcast('invoice.confirmed', {
      invoice_id: p.invoiceId,
      rep_id: p.repId,
      customer_id: p.customerId,
      total: p.grandTotal,
    });
  }

  @OnEvent('route.deviated')
  onRouteDeviated(p: {
    repId: string;
    planId: string;
    nearestStopMeters: number;
  }): void {
    this.gateway.broadcast('route.deviated', {
      rep_id: p.repId,
      plan_id: p.planId,
      deviation_m: p.nearestStopMeters,
    });
  }

  @OnEvent('rep.offline')
  onRepOffline(p: { repId: string; lastSeen: Date | null }): void {
    this.gateway.broadcast('rep.offline', {
      rep_id: p.repId,
      last_seen: p.lastSeen,
    });
  }

  @OnEvent('rep.online')
  onRepOnline(p: { repId: string; at: Date }): void {
    this.gateway.broadcast('rep.online', { rep_id: p.repId, ts: p.at });
  }

  @OnEvent('rep.gps_off')
  onRepGpsOff(p: { repId: string; at: Date }): void {
    this.gateway.broadcast('rep.gps_off', { rep_id: p.repId, ts: p.at });
  }

  @OnEvent('rep.gps_on')
  onRepGpsOn(p: { repId: string; at: Date }): void {
    this.gateway.broadcast('rep.gps_on', { rep_id: p.repId, ts: p.at });
  }

  @OnEvent('rep.app_closed')
  onRepAppClosed(p: { repId: string; at: Date }): void {
    this.gateway.broadcast('rep.app_closed', { rep_id: p.repId, ts: p.at });
  }

  // Reserved for plan 08:
  @OnEvent('anomaly.flagged')
  onAnomaly(p: Record<string, unknown>): void {
    this.gateway.broadcast('anomaly.flagged', p);
  }

  @OnEvent('cheque.scanned')
  onChequeScanned(p: Record<string, unknown>): void {
    this.gateway.broadcast('cheque.scanned', p);
  }

  // F10 — approvals + notification inbox
  @OnEvent('approval.requested')
  onApprovalRequested(p: Record<string, unknown>): void {
    this.gateway.broadcast('approval.requested', p);
  }

  @OnEvent('approval.decided')
  onApprovalDecided(p: Record<string, unknown>): void {
    this.gateway.broadcast('approval.decided', p);
  }

  @OnEvent('notification.created')
  onNotificationCreated(p: Record<string, unknown>): void {
    this.gateway.broadcast('notification.created', p);
  }
}
