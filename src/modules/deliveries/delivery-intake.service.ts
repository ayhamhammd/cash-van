import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  ErpOutboxService,
  TerminalPayloadError,
  type OutboxCall,
  type OutboxKindHandler,
} from '../erp-sync/erp-outbox.service';
import type { ErpOutbox } from '../erp-sync/entities/erp-outbox.entity';
import { enqueueOutboxWithin } from '../erp-sync/outbox-enqueue';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DeliveriesService } from './deliveries.service';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { erpErrorCode, unwrapRun } from './erp-delivery.types';
import type { SyncDeliveryDto } from './dto/deliveries.dto';

export const DELIVERY_RESULT_KIND = 'DELIVERY_RESULT' as const;

/** ERP refusals of a result that no retry can change (contract §A "Result"). */
const TERMINAL_RESULT_CODES = new Set(['STOP_ALREADY_FINAL', 'RUN_CLOSED']);

/** What `voucher_inbox.payload` holds for a DELIVERY row — everything the push needs. */
export interface DeliveryInboxPayload {
  clientRef: string;
  stopId: string;
  /** The ERP run item id, captured at intake: the stop may change runs later. */
  erpItemId: string;
  runErpId: string | null;
  outcome: 'DELIVERED' | 'RETURNED';
  deliveredAt: string;
  signedByName?: string | null;
  lat?: number | null;
  lng?: number | null;
  note?: string | null;
}

export interface DeliveryIntakeVerdict {
  status: 'accepted' | 'rejected';
  reason?: string;
}

/** Is a stop final, as far as a NEW result is concerned? */
export function stopIsFinal(stop: Pick<DeliveryStop, 'status' | 'localResultRef'>): boolean {
  return stop.status !== 'LOADED' || !!stop.localResultRef;
}

/** The ERP call for one queued result. Pure, for the spec. */
export function buildResultCall(p: DeliveryInboxPayload): OutboxCall {
  return {
    path: `delivery-runs/items/${encodeURIComponent(p.erpItemId)}/result`,
    idem: p.clientRef,
    body: {
      externalId: p.clientRef,
      outcome: p.outcome,
      deliveredAt: p.deliveredAt,
      ...(p.signedByName ? { signedByName: p.signedByName } : {}),
      ...(p.lat !== undefined && p.lat !== null ? { lat: p.lat } : {}),
      ...(p.lng !== undefined && p.lng !== null ? { lng: p.lng } : {}),
      ...(p.note ? { note: p.note } : {}),
    },
  };
}

/** A 409 STOP_ALREADY_FINAL / RUN_CLOSED is the ERP's last word on this result. */
export function isTerminalResultRefusal(status: number, body: unknown): boolean {
  return status === 409 && TERMINAL_RESULT_CODES.has(erpErrorCode(body) ?? '');
}

/**
 * The delivery rep's result for one stop (`POST sync/deliveries`) and its
 * journey to the ERP (outbox DELIVERY_RESULT).
 *
 * Staging: `voucher_inbox`, type DELIVERY. It is the table the phone's other
 * documents already go through — its client_ref unique index is the
 * idempotency key, `GET /sync/status` answers for it unchanged, and the office
 * sees it in the Sync inbox. Unlike a voucher there is nothing to promote
 * later: the mirror and the outbox are written in the same transaction as the
 * row, so it is stored `posted` and the inbox drain never picks it up.
 *
 * The ERP's verdict arrives through the outbox. Accepted: the run it answers
 * with is mirrored and the stop stops being SENDING. Refused for good (409
 * STOP_ALREADY_FINAL / RUN_CLOSED): the row dead-letters, the stop stops being
 * SENDING, and the run is re-read so the mirror shows what the ERP holds.
 */
@Injectable()
export class DeliveryIntakeService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryIntakeService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deliveries: DeliveriesService,
    private readonly mirror: DeliveryMirrorService,
    private readonly outbox: ErpOutboxService,
  ) {}

  onModuleInit(): void {
    this.outbox.registerHandler(DELIVERY_RESULT_KIND, this.outboxHandler());
  }

  /**
   * Take one result. Idempotent on clientRef: the same ref again is `accepted`
   * and changes nothing. 409 STOP_ALREADY_FINAL when the stop already has a
   * result under another ref (on the ERP, or in flight from this server).
   */
  async ingest(dto: SyncDeliveryDto, actor: AuthenticatedUser): Promise<DeliveryIntakeVerdict> {
    const rep = await this.deliveries.requireDeliveryRep(actor);
    const clientRef = dto.clientRef.trim();
    const outcome = await this.dataSource.transaction(async (em) => {
      const seen: Array<{ type: string }> = await em.query(
        `SELECT type FROM voucher_inbox WHERE client_ref = $1`,
        [clientRef],
      );
      if (seen[0]) {
        return seen[0].type === 'DELIVERY'
          ? { verdict: { status: 'accepted' as const } }
          : { verdict: { status: 'rejected' as const, reason: 'CLIENT_REF_IN_USE' } };
      }

      const locked: Array<{ id: string }> = await em.query(
        `SELECT id FROM delivery_stops WHERE id = $1 FOR UPDATE`,
        [dto.stopId],
      );
      if (!locked[0]) return { verdict: { status: 'rejected' as const, reason: 'STOP_NOT_FOUND' } };
      const stop = await em.getRepository(DeliveryStop).findOneByOrFail({ id: dto.stopId });
      const sameResult =
        stop.localResultRef === clientRef || stop.resultExternalRef === clientRef;
      if (stopIsFinal(stop) && !sameResult) {
        throw new ConflictException({
          message: 'This stop already has a result',
          code: 'STOP_ALREADY_FINAL',
        });
      }
      const run = await em.getRepository(DeliveryRun).findOneBy({ id: stop.runId });

      const payload: DeliveryInboxPayload = {
        clientRef,
        stopId: stop.id,
        erpItemId: stop.erpId,
        runErpId: run?.erpId ?? null,
        outcome: dto.outcome,
        deliveredAt: new Date(dto.deliveredAt).toISOString(),
        signedByName: dto.signedByName?.trim() || null,
        lat: dto.lat ?? null,
        lng: dto.lng ?? null,
        note: dto.note?.trim() || null,
      };
      const claimed: Array<{ id: string }> = await em.query(
        `INSERT INTO voucher_inbox
           (type, client_ref, rep_id, user_code, payload, status, result_ref, processed_at, last_attempt_at)
         VALUES ('DELIVERY', $1, $2, $3, $4::jsonb, 'posted', $5, now(), now())
         ON CONFLICT (client_ref) DO NOTHING
         RETURNING id`,
        [clientRef, rep.id, rep.code ?? null, JSON.stringify(payload), stop.id],
      );
      if (!claimed[0]) return { verdict: { status: 'accepted' as const } };

      // The office sees "delivered — sending to ERP" right away.
      await em.getRepository(DeliveryStop).update(
        { id: stop.id },
        {
          localResultRef: clientRef,
          localOutcome: dto.outcome,
          localDeliveredAt: new Date(payload.deliveredAt),
          localSignedBy: payload.signedByName ?? null,
          localLat: payload.lat != null ? String(payload.lat) : null,
          localLng: payload.lng != null ? String(payload.lng) : null,
          localNote: payload.note ?? null,
        },
      );
      await enqueueOutboxWithin(em, DELIVERY_RESULT_KIND, clientRef);
      return {
        verdict: { status: 'accepted' as const },
        signal: { runId: stop.runId, stopId: stop.id, repId: run?.repId ?? null },
      };
    });

    if (outcome.signal) {
      this.mirror.signal(
        {
          runId: outcome.signal.runId,
          repId: outcome.signal.repId,
          previousRepId: outcome.signal.repId,
          runChanged: false,
          changedStopIds: [outcome.signal.stopId],
          removedStopIds: [],
        },
        'delivery.result.received',
      );
      // Latency only: the row is durable, the drain is the guarantee.
      void this.outbox.pushRefNow(clientRef).catch(() => undefined);
    }
    return outcome.verdict;
  }

  /** How the outbox pushes and answers DELIVERY_RESULT rows. */
  outboxHandler(): OutboxKindHandler {
    return {
      build: (row) => this.buildCalls(row),
      isTerminal: isTerminalResultRefusal,
      onPosted: (row, reply) => this.onPosted(row, reply),
      onTerminal: (row) => this.onTerminal(row),
    };
  }

  private async buildCalls(row: ErpOutbox): Promise<OutboxCall[]> {
    const rows: Array<{ payload: DeliveryInboxPayload }> = await this.dataSource.query(
      `SELECT payload FROM voucher_inbox WHERE client_ref = $1 AND type = 'DELIVERY'`,
      [row.ref],
    );
    const payload = rows[0]?.payload;
    if (!payload?.erpItemId) {
      throw new TerminalPayloadError(`Delivery result ${row.ref} has no staged payload`);
    }
    return [buildResultCall(payload)];
  }

  /** Accepted: mirror the run the ERP answered with; the stop is no longer SENDING. */
  private async onPosted(row: ErpOutbox, reply: unknown): Promise<void> {
    const run = unwrapRun(reply);
    if (run && Array.isArray(run.items)) {
      await this.mirror.applyRun(run, { settledRef: row.ref });
      // The answer may be a stale replay (an older run version): settle anyway.
      await this.mirror.settleRef(row.ref);
      return;
    }
    const runErpId = await this.runErpIdFor(row.ref);
    if (runErpId) await this.mirror.pullRun(runErpId, { settledRef: row.ref });
    await this.mirror.settleRef(row.ref);
  }

  /** Refused for good: stop showing SENDING and show what the ERP holds. */
  private async onTerminal(row: ErpOutbox): Promise<void> {
    const runErpId = await this.runErpIdFor(row.ref);
    await this.mirror.settleRef(row.ref);
    if (runErpId) {
      await this.mirror.pullRun(runErpId).catch((e: unknown) =>
        this.logger.warn(
          `re-reading run ${runErpId} after a refused result failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
    }
  }

  private async runErpIdFor(clientRef: string): Promise<string | null> {
    const rows: Array<{ erp_id: string }> = await this.dataSource.query(
      `SELECT r.erp_id
         FROM delivery_stops s JOIN delivery_runs r ON r.id = s.run_id
        WHERE s.local_result_ref = $1
        UNION ALL
       SELECT payload->>'runErpId' FROM voucher_inbox
        WHERE client_ref = $1 AND type = 'DELIVERY' AND payload->>'runErpId' IS NOT NULL
        LIMIT 1`,
      [clientRef],
    );
    return rows[0]?.erp_id ?? null;
  }
}
