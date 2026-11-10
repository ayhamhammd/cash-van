import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
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
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import { DeliveryProof } from './entities/delivery-proof.entity';
import type { IncreaseLine } from './entities/delivery-increase-request.entity';
import {
  ITEMS_AR,
  LINES_AR,
  PRODUCT_UNIT_SQL,
  arabicCount,
  increaseLineOf,
  type ProductUnitRow,
} from './delivery-increase-units';
import { attachmentIdOf, erpErrorCode, unwrapRun } from './erp-delivery.types';
import { checkLines, checkProofs, type RejectReason } from './delivery-result-checks';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../../common/storage/storage.service';
import type { SyncDeliveryDto } from './dto/deliveries.dto';

export const DELIVERY_RESULT_KIND = 'DELIVERY_RESULT' as const;
export const DELIVERY_PROOF_KIND = 'DELIVERY_PROOF' as const;

/** ERP refusals of a result that no retry can change (contract §A "Result"). */
const TERMINAL_RESULT_CODES = new Set(['STOP_ALREADY_FINAL', 'RUN_CLOSED']);

/** What `voucher_inbox.payload` holds for a DELIVERY row — everything the push needs. */
export interface DeliveryInboxPayload {
  clientRef: string;
  stopId: string;
  /** The ERP run item id, captured at intake: the stop may change runs later. */
  erpItemId: string;
  runErpId: string | null;
  outcome: 'DELIVERED' | 'PARTIAL' | 'RETURNED';
  deliveredAt: string;
  signedByName?: string | null;
  lat?: number | null;
  lng?: number | null;
  note?: string | null;
  /** The lines the phone SENT, as the ERP names them; the ERP fills the rest in. */
  lines?: Array<{ invoiceItemId: string; deliveredQty: number; reasonCode?: string | null; note?: string | null }>;
  /** Proof clientRefs; the result is held until each has its ERP attachment id. */
  proofRefs?: string[];
  /** The customer wanted more (phase 4): sent to the ERP as `increase`. */
  increase?: Array<{ skuCode: string; qty: number }>;
  /** Lines that came back short, for the office's notification. */
  differingLines?: number;
}

export interface DeliveryIntakeVerdict {
  status: 'accepted' | 'rejected';
  reason?: RejectReason | 'STOP_NOT_FOUND' | 'CLIENT_REF_IN_USE' | 'INCREASE_UNKNOWN_PRODUCT';
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
      ...(p.lines?.length
        ? {
            lines: p.lines.map((l) => ({
              invoiceItemId: l.invoiceItemId,
              deliveredQty: l.deliveredQty,
              ...(l.reasonCode ? { reasonCode: l.reasonCode } : {}),
              ...(l.note ? { note: l.note } : {}),
            })),
          }
        : {}),
      ...(p.increase?.length ? { increase: p.increase.map((l) => ({ skuCode: l.skuCode, qty: l.qty })) } : {}),
    },
  };
}

/**
 * One line per product, quantities added together (a picker can send the same
 * product twice), rounded to the invoice-line scale.
 */
export function mergeIncrease(lines: Array<{ productId: string; qty: number }>): Array<{ productId: string; qty: number }> {
  const by = new Map<string, number>();
  for (const l of lines) by.set(l.productId, (by.get(l.productId) ?? 0) + l.qty);
  return [...by.entries()].map(([productId, qty]) => ({ productId, qty: Math.round(qty * 1000) / 1000 }));
}

/** The ERP attachment upload for one proof. Pure, for the spec. */
export function buildProofCall(
  proof: Pick<DeliveryProof, 'clientRef' | 'kind' | 'mime' | 'storageKey'>,
  erpItemId: string,
  buffer: Buffer,
): OutboxCall {
  return {
    path: 'attachments',
    idem: proof.clientRef,
    body: {},
    multipart: {
      fields: { entityType: 'DELIVERY_RUN_ITEM', entityId: erpItemId, role: proof.kind },
      file: {
        buffer,
        filename: proof.storageKey.split('/').pop() ?? `${proof.clientRef}`,
        contentType: proof.mime,
      },
    },
  };
}

/** `data.warnings` (or top-level `warnings`) of a result reply, e.g. INCREASE_LINE_DROPPED. */
export function resultWarnings(reply: unknown): Array<{ code: string; skuCode?: string; reason?: string }> {
  const top = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : null;
  const data = top?.data && typeof top.data === 'object' ? (top.data as Record<string, unknown>) : null;
  const list = (Array.isArray(data?.warnings) ? data!.warnings : Array.isArray(top?.warnings) ? top!.warnings : []) as unknown[];
  return list
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
    .map((w) => ({
      code: String(w.code ?? 'WARNING'),
      ...(typeof w.skuCode === 'string' ? { skuCode: w.skuCode } : {}),
      ...(typeof w.reason === 'string' ? { reason: w.reason } : {}),
    }));
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
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.outbox.registerHandler(DELIVERY_RESULT_KIND, this.outboxHandler());
    this.outbox.registerHandler(DELIVERY_PROOF_KIND, this.proofHandler());
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
          : { verdict: { status: 'rejected' as const, reason: 'CLIENT_REF_IN_USE' as const } };
      }

      const locked: Array<{ id: string }> = await em.query(
        `SELECT id FROM delivery_stops WHERE id = $1 FOR UPDATE`,
        [dto.stopId],
      );
      if (!locked[0]) return { verdict: { status: 'rejected' as const, reason: 'STOP_NOT_FOUND' as const } };
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

      // The lines against the stop, the outcome against the lines.
      const stopLines = await em.getRepository(DeliveryStopLine).find({ where: { stopId: stop.id } });
      const lines = checkLines(
        stopLines.map((l) => ({ erpInvoiceItemId: l.erpInvoiceItemId, invoicedQty: Number(l.invoicedQty) || 0 })),
        dto.outcome,
        dto.lines,
      );
      if (!lines.ok) return { verdict: { status: 'rejected' as const, reason: lines.reason } };

      // The proofs it names: uploaded for this stop, and enough of them.
      const proofRefs = [...new Set((dto.proofRefs ?? []).map((r) => r.trim()).filter(Boolean))];
      const uploaded = proofRefs.length
        ? await em.getRepository(DeliveryProof).find({
            where: proofRefs.map((clientRef) => ({ clientRef, stopId: stop.id })),
          })
        : [];
      const proofProblem = checkProofs(await this.proofRequired(em), dto.outcome, proofRefs, uploaded);
      if (proofProblem) return { verdict: { status: 'rejected' as const, reason: proofProblem } };

      // The customer wants more (phase 4). Only with the company switch on;
      // off, the request is dropped and the delivery still goes through.
      let increase: IncreaseLine[] = [];
      if (dto.increase?.length) {
        if (!(await this.increaseRequestsOn(em))) {
          this.logger.log(
            `result ${clientRef}: increase request ignored (${dto.increase.length} line(s)) — deliveryIncreaseRequests is off`,
          );
        } else {
          const wanted = mergeIncrease(dto.increase);
          const products: ProductUnitRow[] = await em.query(
            `${PRODUCT_UNIT_SQL} AND ic.is_active AND ic.deleted_at IS NULL`,
            [wanted.map((w) => w.productId)],
          );
          const byId = new Map(products.map((p) => [p.id, p]));
          if (wanted.some((w) => !byId.has(w.productId))) {
            return { verdict: { status: 'rejected' as const, reason: 'INCREASE_UNKNOWN_PRODUCT' as const } };
          }
          increase = wanted.map((w) => increaseLineOf(byId.get(w.productId)!, w.qty));
        }
      }

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
        lines: (dto.lines ?? []).map((l) => ({
          invoiceItemId: l.erpInvoiceItemId,
          deliveredQty: l.deliveredQty,
          reasonCode: l.reasonCode ?? null,
          note: l.note?.trim() || null,
        })),
        proofRefs,
        differingLines: lines.differing,
        ...(increase.length ? { increase: increase.map((l) => ({ skuCode: l.skuCode, qty: l.qty })) } : {}),
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
      // Every line gets the phone's figure, so the office sees the difference
      // (and goods coming back) before the ERP has answered.
      for (const l of lines.lines) {
        await em.getRepository(DeliveryStopLine).update(
          { stopId: stop.id, erpInvoiceItemId: l.erpInvoiceItemId },
          { localDeliveredQty: String(l.deliveredQty), localReasonCode: l.reasonCode, localNote: l.note },
        );
      }
      if (increase.length) {
        await em.query(
          `INSERT INTO delivery_increase_requests
             (client_ref, stop_id, run_id, customer_id, rep_id, invoice_number, lines)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (client_ref) DO NOTHING`,
          [clientRef, stop.id, stop.runId, stop.customerId ?? null, rep.id, stop.invoiceNumber ?? null, JSON.stringify(increase)],
        );
      }
      // Proofs first, then the result — which waits for them anyway.
      for (const ref of proofRefs) await enqueueOutboxWithin(em, DELIVERY_PROOF_KIND, ref);
      await enqueueOutboxWithin(em, DELIVERY_RESULT_KIND, clientRef);
      return {
        verdict: { status: 'accepted' as const },
        signal: { runId: stop.runId, stopId: stop.id, repId: run?.repId ?? null },
        proofRefs,
        returnRequest: lines.differing
          ? {
              stopId: stop.id,
              invoiceNumber: stop.invoiceNumber ?? '',
              customer: stop.recipientName ?? stop.customerCode ?? '',
              lines: lines.differing,
            }
          : null,
        increaseRequest: increase.length
          ? {
              stopId: stop.id,
              invoiceNumber: stop.invoiceNumber ?? '',
              customer: stop.recipientName ?? stop.customerCode ?? '',
              items: increase.length,
            }
          : null,
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
      if (outcome.returnRequest) await this.notifyReturnRequest(outcome.returnRequest);
      if (outcome.increaseRequest) await this.notifyIncreaseRequest(outcome.increaseRequest);
      // Latency only: the rows are durable, the drain is the guarantee.
      const refs = outcome.proofRefs ?? [];
      void (async () => {
        for (const ref of refs) await this.outbox.pushRefNow(ref);
        await this.outbox.pushRefNow(clientRef);
      })().catch(() => undefined);
    }
    return outcome.verdict;
  }

  /** "Return request: invoice X, customer Y, n lines" to every manager. Best effort. */
  private async notifyReturnRequest(r: {
    stopId: string;
    invoiceNumber: string;
    customer: string;
    lines: number;
  }): Promise<void> {
    try {
      await this.notifications.notifyManagers({
        kind: 'delivery.return_requested',
        titleAr: 'طلب إرجاع',
        titleEn: 'Return request',
        bodyAr: `الفاتورة ${r.invoiceNumber}، الزبون ${r.customer}، ${arabicCount(r.lines, LINES_AR)}`,
        bodyEn: `Return request: invoice ${r.invoiceNumber}, customer ${r.customer}, ${r.lines} line${r.lines === 1 ? '' : 's'}`,
        refType: 'delivery_stop',
        refId: r.stopId,
      });
    } catch (e) {
      // The result is taken; a failed alert must not turn it into a failure.
      this.logger.warn(`return-request notification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** "Increase request: invoice X, customer Y, n items" to every manager. Best effort. */
  private async notifyIncreaseRequest(r: {
    stopId: string;
    invoiceNumber: string;
    customer: string;
    items: number;
  }): Promise<void> {
    try {
      await this.notifications.notifyManagers({
        kind: 'delivery.increase_requested',
        titleAr: 'طلب زيادة',
        titleEn: 'Increase request',
        bodyAr: `طلب زيادة: الفاتورة ${r.invoiceNumber}، الزبون ${r.customer}، ${arabicCount(r.items, ITEMS_AR)}`,
        bodyEn: `Increase request: invoice ${r.invoiceNumber}, customer ${r.customer}, ${r.items} item${r.items === 1 ? '' : 's'}`,
        refType: 'delivery_stop',
        refId: r.stopId,
      });
    } catch (e) {
      this.logger.warn(`increase-request notification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** app_settings.delivery_increase_requests (default off). */
  private async increaseRequestsOn(em: EntityManager): Promise<boolean> {
    // With Delivery & collection switched off the sub-flag has no effect.
    const rows: Array<{ on: boolean; enabled?: boolean | null }> = await em.query(
      `SELECT delivery_increase_requests AS "on", delivery_enabled AS enabled FROM app_settings WHERE id = 1`,
    );
    return rows[0]?.on === true && rows[0]?.enabled !== false;
  }

  /** app_settings.delivery_proof_required (default on). */
  private async proofRequired(em: EntityManager): Promise<boolean> {
    // With Delivery & collection switched off the sub-flag has no effect: a
    // result a phone saved before the switch is never refused for its proofs.
    const rows: Array<{ required: boolean; enabled?: boolean | null }> = await em.query(
      `SELECT delivery_proof_required AS required, delivery_enabled AS enabled FROM app_settings WHERE id = 1`,
    );
    return rows[0]?.required !== false && rows[0]?.enabled !== false;
  }

  /**
   * How the outbox pushes DELIVERY_PROOF rows: the stored file, multipart to
   * the ERP's attachments with the proof's clientRef as Idempotency-Key. Once
   * the ERP has it, any result waiting on it is woken.
   */
  proofHandler(): OutboxKindHandler {
    return {
      build: async (row) => {
        const proof = await this.dataSource.getRepository(DeliveryProof).findOne({
          where: { clientRef: row.ref },
        });
        if (!proof) throw new TerminalPayloadError(`Delivery proof ${row.ref} no longer exists`);
        const stop = await this.dataSource.getRepository(DeliveryStop).findOne({ where: { id: proof.stopId } });
        if (!stop) throw new TerminalPayloadError(`The stop of proof ${row.ref} no longer exists`);
        const buffer = await this.storage.read(proof.storageKey).catch(() => null);
        if (!buffer) throw new TerminalPayloadError(`The file of proof ${row.ref} is missing`);
        return [buildProofCall(proof, stop.erpId, buffer)];
      },
      onPosted: async (row, reply) => {
        await this.dataSource.getRepository(DeliveryProof).update(
          { clientRef: row.ref },
          // A replay may answer without the id; the result must not wait for ever on it.
          { erpAttachmentId: attachmentIdOf(reply) ?? 'UNKNOWN' },
        );
        await this.wakeResultsWaitingOn(row.ref);
      },
    };
  }

  /** Results naming this proof are due now, not at the end of their backoff. */
  private async wakeResultsWaitingOn(proofRef: string): Promise<void> {
    const res: unknown = await this.dataSource.query(
      `UPDATE erp_outbox o
          SET next_attempt_at = now()
         FROM voucher_inbox i
        WHERE o.kind = 'DELIVERY_RESULT' AND o.status = 'pending'
          AND i.client_ref = o.ref AND i.type = 'DELIVERY'
          AND i.payload->'proofRefs' ? $1
       RETURNING o.ref`,
      [proofRef],
    );
    // TypeORM hands an UPDATE … RETURNING back as [rows, count].
    const rows = (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res) as Array<{ ref: string }>;
    for (const r of Array.isArray(rows) ? rows : []) {
      void this.outbox.pushRefNow(r.ref).catch(() => undefined);
    }
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

  private async buildCalls(row: ErpOutbox): Promise<OutboxCall[] | null> {
    const rows: Array<{ payload: DeliveryInboxPayload }> = await this.dataSource.query(
      `SELECT payload FROM voucher_inbox WHERE client_ref = $1 AND type = 'DELIVERY'`,
      [row.ref],
    );
    const payload = rows[0]?.payload;
    if (!payload?.erpItemId) {
      throw new TerminalPayloadError(`Delivery result ${row.ref} has no staged payload`);
    }
    // Held until every proof it names is on the ERP (null = not yet, no
    // attempt spent; the proof's own push wakes it).
    if (payload.proofRefs?.length) {
      const waiting: Array<{ n: number }> = await this.dataSource.query(
        `SELECT count(*)::int AS n FROM delivery_proofs
          WHERE client_ref = ANY($1::text[]) AND erp_attachment_id IS NULL`,
        [payload.proofRefs],
      );
      if ((waiting[0]?.n ?? 0) > 0) return null;
    }
    return [buildResultCall(payload)];
  }

  /** Accepted: mirror the run the ERP answered with; the stop is no longer SENDING. */
  private async onPosted(row: ErpOutbox, reply: unknown): Promise<void> {
    // The ERP keeps the result and drops increase lines it cannot take (an
    // unknown or archived SKU, a bad quantity, past 30 lines). Not an error:
    // CashVan's own request row and the order made from it are unaffected.
    for (const w of resultWarnings(reply)) {
      this.logger.warn(
        `result ${row.ref}: ERP warning ${w.code}${w.skuCode ? ` (${w.skuCode})` : ''}${w.reason ? `: ${w.reason}` : ''}`,
      );
    }
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
