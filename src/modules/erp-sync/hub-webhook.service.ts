import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

import { SettingsService } from '../settings/settings.service';
import { HubWebhookEvent, HubWebhookStatus } from './entities/hub-webhook-event.entity';

export interface WebhookResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** Max clock skew (seconds) tolerated on X-Hub-Timestamp when a secret is set. */
const MAX_SKEW_SECONDS = 5 * 60;

/**
 * Inbound Integration Hub webhooks (Hub → Van). Verifies the HMAC signature,
 * dedupes (idempotent re-delivery), records the event, and dispatches it.
 * Signature mirrors the Hub: HMAC-SHA256(secret, `${timestamp}.${rawBody}`),
 * header `X-Hub-Signature: sha256=<hex>`. See docs/SPEC-integration-hub.md §3.3.
 */
@Injectable()
export class HubWebhookService {
  private readonly logger = new Logger(HubWebhookService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventEmitter2,
    @InjectRepository(HubWebhookEvent)
    private readonly repo: Repository<HubWebhookEvent>,
  ) {}

  async receive(rawBody: string, headers: Headers): Promise<WebhookResult> {
    const cfg = await this.settings.getHubConfig();

    // ── 1. Verify signature ─────────────────────────────────────────────────
    const timestamp = headers.get('x-hub-timestamp') ?? '';
    const signature = headers.get('x-hub-signature');
    const verify = this.verify(cfg.webhookSecret, timestamp, rawBody, signature);
    if (!verify.ok) {
      return { httpStatus: 401, body: { error: { code: 'invalid_signature', message: verify.message } } };
    }

    // ── 2. Parse ────────────────────────────────────────────────────────────
    let payload: Record<string, unknown>;
    try {
      payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      return { httpStatus: 400, body: { error: { code: 'bad_json', message: 'Invalid JSON body.' } } };
    }
    const eventType =
      (payload.eventType as string | undefined) ?? headers.get('x-hub-event-type') ?? 'unknown';
    const data = (payload.data as Record<string, unknown> | undefined) ?? undefined;
    const externalId =
      (data?.externalId as string | undefined) ?? (payload.id as string | undefined) ?? null;
    const dedupKey = `${eventType}:${
      (payload.id as string | undefined) ??
      (data?.externalId as string | undefined) ??
      createHash('sha256').update(rawBody).digest('hex').slice(0, 40)
    }`;

    // ── 3. Dedup (unique dedup_key) ─────────────────────────────────────────
    let row: HubWebhookEvent;
    try {
      row = await this.repo.save(
        this.repo.create({ dedupKey, eventType, externalId, payload, status: 'received' }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }
      throw e;
    }

    // ── 4. Dispatch (best-effort; a handler error is logged, not fatal) ──────
    try {
      const handled = await this.dispatch(eventType, payload);
      await this.repo.update(row.id, {
        status: handled ? 'processed' : 'ignored',
        processedAt: new Date(),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.warn(`hub webhook ${eventType} handler failed: ${error}`);
      await this.repo.update(row.id, { status: 'error', error, processedAt: new Date() });
    }

    return { httpStatus: 200, body: { received: true, id: row.id } };
  }

  // ── Signature ──────────────────────────────────────────────────────────────
  private verify(
    secret: string | null,
    timestamp: string,
    rawBody: string,
    header: string | null,
  ): { ok: true } | { ok: false; message: string } {
    if (!secret) {
      // No secret configured: allow in dev, deny in prod (mirrors the Hub).
      if (process.env.NODE_ENV === 'production') {
        return { ok: false, message: 'No Hub webhook secret configured.' };
      }
      return { ok: true };
    }
    if (!timestamp || !header) return { ok: false, message: 'Missing signature or timestamp header.' };

    const ts = Number(timestamp);
    if (Number.isFinite(ts)) {
      const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
      if (skew > MAX_SKEW_SECONDS) return { ok: false, message: 'Timestamp outside the allowed window.' };
    }

    const received = header.startsWith('sha256=') ? header.slice(7) : header;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const a = Buffer.from(received, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
      return { ok: false, message: 'Signature verification failed.' };
    }
    return { ok: true };
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  /** Returns true when handled, false when ignored (no handler for the type). */
  private async dispatch(eventType: string, payload: Record<string, unknown>): Promise<boolean> {
    switch (eventType) {
      case 'inventory.stock_changed':
        // ERP adjusted stock (e.g. van load/return applied ERP-side). The exact
        // `data` shape is ERP-defined (SPEC D2) — emit an internal event so a
        // stock handler can reconcile balances once the payload is confirmed.
        this.events.emit('hub.inventory.stock_changed', payload.data ?? payload);
        this.logger.log(`hub inventory.stock_changed received`);
        return true;

      case 'sales_invoice.created':
      case 'payment.created':
      case 'sales_return.created':
      case 'stock_transfer.created':
        // Status echo for a doc we originated — our outbox already captured the
        // ERP number synchronously, so this is confirmation/audit only.
        this.events.emit(`hub.${eventType}`, payload.data ?? payload);
        return true;

      default:
        this.logger.log(`hub webhook ignored (unhandled type: ${eventType})`);
        return false;
    }
  }

  // ── Ops (admin) ──────────────────────────────────────────────────────────
  /** Recent inbound events for the ops log (most recent first). */
  list(status?: HubWebhookStatus, limit = 100): Promise<HubWebhookEvent[]> {
    return this.repo.find({
      where: status ? { status } : {},
      order: { receivedAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /** Re-run the dispatch for a stored event (recover an errored/ignored one). */
  async reprocess(id: string): Promise<HubWebhookEvent> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Hub webhook event not found.');
    try {
      const handled = await this.dispatch(row.eventType, row.payload ?? {});
      await this.repo.update(id, {
        status: handled ? 'processed' : 'ignored',
        error: null,
        processedAt: new Date(),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.repo.update(id, { status: 'error', error, processedAt: new Date() });
    }
    return (await this.repo.findOne({ where: { id } }))!;
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; driverError?: { code?: string } })?.code
    ?? (e as { driverError?: { code?: string } })?.driverError?.code;
  return code === '23505';
}
