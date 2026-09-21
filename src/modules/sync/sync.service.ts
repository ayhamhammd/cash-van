import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';

import { VoucherInbox, InboxType } from './entities/voucher-inbox.entity';
import { VouchersService } from '../vouchers/vouchers.service';
import { CollectionsService } from '../collections/collections.service';
import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import { SettingsService } from '../settings/settings.service';
import { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import { CreateCollectionDto } from '../collections/dto/create-collection.dto';
import { SyncVoucherDto, SyncCollectionDto, ListInboxQueryDto } from './dto/sync.dto';
import { PERM_ON_BEHALF } from '../../common/constants/permissions';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * What the handset is told about one document.
 *
 * `status` is DERIVED from the stored row, not copied from it: the row tracks
 * whether a retry is due, the device needs to know whether it may drop its local
 * copy. Conflating the two is what let a `failed` row travel inside a 201.
 */
export interface IntakeResult {
  /** Inbox row id. */
  id: string;
  /** Echoed so the app can match without trusting array order. */
  clientRef: string;
  /** Authoritative number. May differ from the one the app minted. */
  voucherNumber: string;
  /** The app's own number, when it supplied one. */
  clientNumber?: string | null;
  status: IntakeVerdict;
  attempts: number;
  error?: string | null;
  /** True only while the server still intends to try again. */
  retryable: boolean;
}

/**
 * accepted — durably staged, not yet in the main tables. KEEP the local copy.
 * posted    — in the main tables. The device may drop its copy.
 * rejected  — terminal. Drop the copy and SHOW the rep: a human must act.
 */
export type IntakeVerdict = 'accepted' | 'posted' | 'rejected';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(VoucherInbox)
    private readonly inbox: Repository<VoucherInbox>,
    private readonly vouchers: VouchersService,
    private readonly collections: CollectionsService,
    private readonly erpOutbox: ErpOutboxService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Stage a voucher from the mobile app: claim the clientRef, assign an
   * authoritative number, then try to promote it into the main tables.
   *
   * The verdict travels in the BODY, not in the HTTP status — see
   * `IntakeResult`. The controller answers 202 whatever happens, because "the
   * server has durably taken responsibility for this document" and "the
   * document posted" are different facts and the handset needs both.
   */
  async ingestVoucher(
    dto: SyncVoucherDto,
    actor: AuthenticatedUser,
  ): Promise<IntakeResult> {
    const { clientRef, ...voucher } = dto;

    // WHO this document belongs to is decided by the token, not by the body.
    // `userCode` used to be taken from the payload with nothing compared against
    // the caller, so any authenticated user could post a sale out of another
    // rep's van, in that rep's name, against that rep's stock and settlement.
    const acting = await this.resolveActingRep(voucher.userCode, null, actor);
    voucher.userCode = acting.userCode;
    const repId = acting.repId;

    const claim = await this.claim({
      type: 'VOUCHER',
      clientRef: this.idempotencyKey(clientRef, 'voucher'),
      repId,
      userCode: acting.userCode,
      clientNumber: voucher.voucherNumber?.trim() || null,
      payload: voucher as unknown as Record<string, unknown>,
    });

    // We lost the race, or this is an ordinary replay. Either way another
    // request owns this document; answer from its row rather than making a
    // second one. This is the NORMAL path for a handset retrying a request that
    // timed out after the server had already accepted it.
    if (!claim.won) return this.resultFor(claim.row);

    // Resolve the store the number is keyed off: a line's store, else the rep's
    // van store. Inject it onto storeless lines so stock moves from the van.
    const store = await this.resolveStore(voucher, repId);

    // Keep the app's own voucher number — a single series across app + server, so
    // the number never changes on upload. Only fall back to a server-reserved
    // number if the client didn't supply one. (App numbers embed the userCode +
    // yearly sequence, so they're unique per rep.)
    //
    // Reserved AFTER the claim, deliberately: reserving first meant every
    // replayed request burned a sequence value and threw it away.
    const assignedNumber =
      voucher.voucherNumber?.trim() ||
      (await this.vouchers.reserveVoucherNumber(voucher.transKind, store));

    await this.inbox.update({ id: claim.row.id }, { assignedNumber });
    claim.row.assignedNumber = assignedNumber;

    await this.promoteVoucher(claim.row, store);
    return this.resultFor(await this.inbox.findOneByOrFail({ id: claim.row.id }));
  }

  async ingestCollection(
    dto: SyncCollectionDto,
    actor: AuthenticatedUser,
  ): Promise<IntakeResult> {
    const { clientRef, ...collection } = dto;

    // Same rule as a voucher: the money lands in the acting rep's settlement, so
    // the acting rep comes from the token.
    const acting = await this.resolveActingRep(
      undefined,
      (collection as { repId?: string }).repId,
      actor,
    );
    (collection as { repId?: string }).repId = acting.repId ?? undefined;

    const claim = await this.claim({
      type: 'COLLECTION',
      clientRef: this.idempotencyKey(clientRef, 'collection'),
      repId: acting.repId,
      userCode: acting.userCode,
      clientNumber: null,
      payload: collection as unknown as Record<string, unknown>,
    });
    if (!claim.won) return this.resultFor(claim.row);

    await this.promoteCollection(claim.row);
    return this.resultFor(await this.inbox.findOneByOrFail({ id: claim.row.id }));
  }

  /**
   * What the handset is told about documents it believes are in flight.
   *
   * This is the endpoint that makes the whole contract work. Without it the app
   * cannot distinguish "the server never received this" from "the server has it
   * and it posted", so it can only guess whether to re-send or to drop its local
   * copy — and guessing wrong either duplicates a sale or loses one.
   *
   * A clientRef that is ABSENT from the reply never reached the server: re-post
   * it.
   */
  async statusFor(
    clientRefs: string[],
    actor: AuthenticatedUser,
  ): Promise<{ items: IntakeResult[] }> {
    const refs = [...new Set(clientRefs.map((r) => r.trim()).filter(Boolean))];
    if (refs.length === 0) return { items: [] };

    // Scoped to the caller's own documents, on the same reasoning as the intake:
    // a rep may reconcile their outbox, not read somebody else's. Refs are
    // opaque device ids, so this is defence in depth rather than the only lock —
    // but an unscoped lookup would let one handset enumerate another's errors.
    const privileged =
      actor.userType === 'ADMIN' || actor.role === 'admin' || actor.role === 'manager';
    const rows = await this.inbox.find({
      where: privileged
        ? { clientRef: In(refs) }
        : { clientRef: In(refs), repId: actor.repId ?? '' },
    });
    return { items: rows.map((r) => this.resultFor(r)) };
  }

  /**
   * Replace a staged document's payload (dashboard "edit"). Only allowed before
   * it has posted; resets the row to pending and clears the previous error so it
   * can be re-exported with a retry.
   */
  async updatePayload(
    id: string,
    payload: Record<string, unknown>,
  ): Promise<VoucherInbox> {
    const row = await this.findOneOrThrow(id);
    if (row.status === 'posted') {
      throw new ConflictException('Cannot edit a document that already posted');
    }
    row.payload = payload;
    row.status = 'pending';
    row.error = null;
    await this.inbox.save(row);
    return this.findOneOrThrow(id);
  }

  /** Re-attempt a pending/failed row (dashboard "retry"). */
  async retry(id: string): Promise<VoucherInbox> {
    const row = await this.findOneOrThrow(id);
    if (row.status === 'posted') return row;
    if (row.type === 'VOUCHER') {
      const store = await this.storeForRow(row);
      await this.promoteVoucher(row, store);
    } else {
      await this.promoteCollection(row);
    }
    return this.findOneOrThrow(id);
  }

  async list(
    q: ListInboxQueryDto,
  ): Promise<{ items: VoucherInbox[]; total: number; pending: number; failed: number }> {
    const [items, total] = await this.inbox.findAndCount({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
      },
      order: { createdAt: 'DESC' },
      skip: q.offset ?? 0,
      take: q.limit ?? 50,
    });
    const pending = await this.inbox.count({ where: { status: 'pending' } });
    const failed = await this.inbox.count({ where: { status: 'failed' } });
    return { items, total, pending, failed };
  }

  async discard(id: string): Promise<void> {
    const row = await this.findOneOrThrow(id);
    await this.inbox.delete({ id: row.id });
  }

  async findOneOrThrow(id: string): Promise<VoucherInbox> {
    const row = await this.inbox.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Inbox item ${id} not found`);
    return row;
  }

  // ---- internals --------------------------------------------------------

  private async promoteVoucher(row: VoucherInbox, store: string): Promise<void> {
    try {
      const dto = { ...(row.payload as unknown as CreateVoucherDto) };
      dto.voucherNumber = row.assignedNumber ?? undefined;
      // Mobile documents are completed transactions → post on promotion.
      dto.isPosted = true;
      // Make sure every line carries the van store so stock moves correctly.
      dto.transactions = (dto.transactions ?? []).map((l) => ({
        ...l,
        storeNumber: l.storeNumber ?? l.fromStoreNumber ?? store,
      }));
      const created = await this.vouchers.create(dto);
      await this.markPosted(row.id, created.voucherNumber);
      // ERP push is enqueued via the 'erp.voucher.posted' event from vouchers.create.
    } catch (e) {
      await this.markFailed(row.id, e);
    }
  }

  private async promoteCollection(row: VoucherInbox): Promise<void> {
    try {
      const created = await this.collections.create(
        row.payload as unknown as CreateCollectionDto,
      );
      await this.markPosted(row.id, (created as { id?: string }).id ?? null);
    } catch (e) {
      await this.markFailed(row.id, e);
    }
  }

  private async markPosted(id: string, resultRef: string | null): Promise<void> {
    await this.inbox.update(
      { id },
      {
        status: 'posted',
        resultRef,
        error: null,
        processedAt: new Date(),
        lastAttemptAt: new Date(),
      },
    );
  }

  private async markFailed(id: string, e: unknown): Promise<void> {
    const error = e instanceof Error ? e.message : String(e);
    this.logger.warn(`Inbox ${id} promotion failed: ${error}`);
    // `attempts` is counted here so the drain (SPEC §4.3) inherits a truthful
    // number rather than starting every existing row from zero.
    await this.inbox.update(
      { id },
      {
        status: 'failed',
        error,
        processedAt: new Date(),
        lastAttemptAt: new Date(),
        attempts: () => '"attempts" + 1',
      },
    );
  }

  /**
   * Claim a clientRef, atomically.
   *
   * `findOne` then `save` is a check-then-insert: two concurrent replays both
   * missed and both inserted, and the unique index handed the loser a raw 23505
   * that surfaced as a 500 — which the handset reads as "retry", forever.
   *
   * `ON CONFLICT DO NOTHING` collapses that into one statement. An empty
   * `RETURNING` is not an error here, it is the replay path: somebody else owns
   * this document, so read their row and answer from it.
   */
  private async claim(input: {
    type: InboxType;
    clientRef: string;
    repId: string | null;
    userCode: string | null;
    clientNumber: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ won: boolean; row: VoucherInbox }> {
    const inserted = await this.inbox
      .createQueryBuilder()
      .insert()
      .values({
        type: input.type,
        clientRef: input.clientRef,
        repId: input.repId,
        userCode: input.userCode,
        clientNumber: input.clientNumber,
        // The insert builder types jsonb as a deep-partial of its own shape;
        // the payload is an opaque document body, so it is passed through.
        payload: input.payload as VoucherInbox['payload'] & object,
        status: 'pending',
      })
      .orIgnore()
      .returning('*')
      .execute();

    const raw = (inserted.raw as VoucherInbox[] | undefined) ?? [];
    if (raw.length > 0) {
      // `returning('*')` gives snake_case straight from Postgres for columns
      // TypeORM did not map on the way out, so re-read rather than trusting the
      // shape. One indexed lookup, on the winning path only.
      return { won: true, row: await this.inbox.findOneByOrFail({ id: raw[0].id }) };
    }
    return {
      won: false,
      row: await this.inbox.findOneByOrFail({ clientRef: input.clientRef }),
    };
  }

  /**
   * An idempotency key is mandatory now that the column is NOT NULL and is the
   * conflict target.
   *
   * A request without one is given a synthetic key rather than refused: an
   * installed APK that does not send `clientRef` would otherwise stop being able
   * to sell the moment this deploys. Such a document cannot be deduped — which
   * is exactly what the warning says, so the gap is visible in the logs of any
   * site still running an old build instead of being inferred later from
   * duplicate sales.
   */
  private idempotencyKey(clientRef: string | undefined, kind: string): string {
    const trimmed = clientRef?.trim();
    if (trimmed) return trimmed;
    const synthetic = `auto:${randomUUID()}`;
    this.logger.warn(
      `A ${kind} arrived with no clientRef; assigned ${synthetic}. This document ` +
        'cannot be deduplicated — the handset build is older than the sync contract.',
    );
    return synthetic;
  }

  /**
   * Translate a stored row into the verdict the device acts on.
   *
   * `pending` means the server still intends to try, so the device keeps its
   * copy. `failed` is terminal TODAY — only a dashboard retry revives it — so it
   * is reported as `rejected` and the rep is shown the reason. When the drain
   * lands (SPEC §4.3) a retryable failure stays `pending` and only a burnt-out
   * row becomes `dead_letter`, at which point this mapping widens rather than
   * changes.
   */
  private resultFor(row: VoucherInbox): IntakeResult {
    const status: IntakeVerdict =
      row.status === 'posted'
        ? 'posted'
        : row.status === 'failed' ||
            row.status === 'rejected' ||
            row.status === 'dead_letter'
          ? 'rejected'
          : 'accepted';
    return {
      id: row.id,
      clientRef: row.clientRef,
      voucherNumber: row.assignedNumber ?? '',
      clientNumber: row.clientNumber ?? null,
      status,
      attempts: row.attempts ?? 0,
      error: row.error ?? null,
      retryable: status === 'accepted',
    };
  }

  /**
   * Who this document belongs to — decided by the token, never by the body.
   *
   * Three cases, and there is no fourth:
   *
   *   1. The caller names nobody, or names themselves → they act as the rep
   *      their own token carries. A caller with no rep link is refused; there is
   *      no such thing as a document with no owner.
   *   2. The caller names a DIFFERENT rep and may act on their behalf (admin,
   *      manager, or `vouchers.createOnBehalf`) → that rep owns it. This is the
   *      office replaying a stuck handset document, or raising one for a rep.
   *   3. The caller names a different rep and may not → 403. Silently rewriting
   *      it to the caller would post the document under a rep the app never
   *      intended, so the mismatch is surfaced rather than corrected.
   *
   * Pass EITHER a `userCode` (vouchers key off `users.user_number`) or a
   * `repId` (collections carry the rep's uuid); the other is resolved here.
   */
  private async resolveActingRep(
    requestedUserCode: string | undefined,
    requestedRepId: string | null | undefined,
    actor: AuthenticatedUser,
  ): Promise<{ repId: string | null; userCode: string }> {
    const wantedCode = requestedUserCode?.trim() || undefined;
    const wantedRepId = requestedRepId?.trim() || undefined;

    const ownByCode = !wantedCode || wantedCode === actor.userNumber;
    const ownByRepId = !wantedRepId || wantedRepId === actor.repId;

    if (ownByCode && ownByRepId) {
      if (!actor.repId) {
        throw new ForbiddenException({
          code: 'no_rep_link',
          message:
            'This account is not linked to a salesman, so it cannot file a document of its own. ' +
            'Name the salesman explicitly (requires permission to act on their behalf).',
        });
      }
      return { repId: actor.repId, userCode: actor.userNumber };
    }

    // Naming someone else. `userType === 'ADMIN'` mirrors PermissionsGuard, which
    // lets a full admin through before any key is consulted.
    const privileged =
      actor.userType === 'ADMIN' || actor.role === 'admin' || actor.role === 'manager';
    if (!privileged && !(actor.permKeys ?? []).includes(PERM_ON_BEHALF)) {
      throw new ForbiddenException({
        code: 'REP_MISMATCH',
        message:
          'This document names a different salesman than your account. ' +
          'Acting on behalf of another salesman needs permission.',
        tokenUserCode: actor.userNumber,
        requested: wantedCode ?? wantedRepId,
      });
    }

    if (wantedRepId) {
      const code = await this.userCodeForRep(wantedRepId);
      if (!code) throw new BadRequestException(`Rep ${wantedRepId} not found`);
      return { repId: wantedRepId, userCode: code };
    }

    const repId = await this.resolveRepId(wantedCode);
    if (!repId) {
      throw new BadRequestException(`No salesman linked to user "${wantedCode}"`);
    }
    return { repId, userCode: wantedCode as string };
  }

  /** The login code (`users.user_number`) behind a rep id. */
  private async userCodeForRep(repId: string): Promise<string | null> {
    const rows: Array<{ user_number: string }> = await this.inbox.manager.query(
      `SELECT u.user_number FROM reps r
         JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.deleted_at IS NULL
        LIMIT 1`,
      [repId],
    );
    return rows[0]?.user_number ?? null;
  }

  private async resolveRepId(userCode?: string): Promise<string | null> {
    if (!userCode) return null;
    const rows: Array<{ id: string }> = await this.inbox.manager.query(
      `SELECT r.id FROM reps r
         JOIN users u ON u.id = r.user_id
        WHERE u.user_number = $1 AND r.deleted_at IS NULL
        LIMIT 1`,
      [userCode],
    );
    return rows[0]?.id ?? null;
  }

  private async resolveStore(
    voucher: CreateVoucherDto,
    repId: string | null,
  ): Promise<string> {
    const line = (voucher.transactions ?? []).find(
      (l) => l.storeNumber || l.fromStoreNumber || l.toStoreNumber,
    );
    const fromLine = line?.storeNumber ?? line?.fromStoreNumber ?? line?.toStoreNumber;
    if (fromLine) return fromLine;
    if (repId) {
      const van = await this.vouchers.resolveRepVanStore(repId);
      if (van) return van;
    }
    return 'NA';
  }

  private async storeForRow(row: VoucherInbox): Promise<string> {
    return this.resolveStore(
      row.payload as unknown as CreateVoucherDto,
      row.repId ?? null,
    );
  }
}
