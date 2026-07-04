import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { EventsGateway } from './events.gateway';

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
