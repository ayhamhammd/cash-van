import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VoucherInbox, InboxStatus } from './entities/voucher-inbox.entity';
import { VouchersService } from '../vouchers/vouchers.service';
import { CollectionsService } from '../collections/collections.service';
import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import { SettingsService } from '../settings/settings.service';
import { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import { CreateCollectionDto } from '../collections/dto/create-collection.dto';
import { SyncVoucherDto, SyncCollectionDto, ListInboxQueryDto } from './dto/sync.dto';
import { PERM_ON_BEHALF } from '../../common/constants/permissions';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

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
   * Stage a voucher from the mobile app: dedupe by clientRef, assign an
   * authoritative number, then try to promote it into the main tables. The
   * assigned number is returned even if promotion fails (the row waits in the
   * inbox for retry) so the device always has a stable, conflict-free number.
   */
  async ingestVoucher(
    dto: SyncVoucherDto,
    actor: AuthenticatedUser,
  ): Promise<{ id: string; voucherNumber: string; status: InboxStatus; error?: string | null }> {
    const { clientRef, ...voucher } = dto;

    // WHO this document belongs to is decided by the token, not by the body.
    // `userCode` used to be taken from the payload with nothing compared against
    // the caller, so any authenticated user could post a sale out of another
    // rep's van, in that rep's name, against that rep's stock and settlement.
    const acting = await this.resolveActingRep(voucher.userCode, null, actor);
    voucher.userCode = acting.userCode;

    // Idempotent replay: same device document → return the existing row.
    if (clientRef) {
      const existing = await this.inbox.findOne({ where: { clientRef } });
      if (existing) {
        return {
          id: existing.id,
          voucherNumber: existing.assignedNumber ?? '',
          status: existing.status,
          error: existing.error,
        };
      }
    }

    // Resolve the store the number is keyed off: a line's store, else the rep's
    // van store. Inject it onto storeless lines so stock moves from the van.
    const repId = acting.repId;
    const store = await this.resolveStore(voucher, repId);
    // Keep the app's own voucher number — a single series across app + server, so
    // the number never changes on upload. Only fall back to a server-reserved
    // number if the client didn't supply one. (App numbers embed the userCode +
    // yearly sequence, so they're unique per rep.)
    const assignedNumber =
      voucher.voucherNumber?.trim() ||
      (await this.vouchers.reserveVoucherNumber(voucher.transKind, store));

    const row = await this.inbox.save(
      this.inbox.create({
        type: 'VOUCHER',
        clientRef: clientRef ?? null,
        repId,
        userCode: voucher.userCode,
        assignedNumber,
        payload: voucher as unknown as Record<string, unknown>,
        status: 'pending',
      }),
    );

    await this.promoteVoucher(row, store);
    const fresh = await this.inbox.findOneByOrFail({ id: row.id });
    return {
      id: fresh.id,
      voucherNumber: assignedNumber,
      status: fresh.status,
      error: fresh.error,
    };
  }

  async ingestCollection(
    dto: SyncCollectionDto,
    actor: AuthenticatedUser,
  ): Promise<{ id: string; status: InboxStatus; error?: string | null }> {
    const { clientRef, ...collection } = dto;

    // Same rule as a voucher: the money lands in the acting rep's settlement, so
    // the acting rep comes from the token.
    const acting = await this.resolveActingRep(
      undefined,
      (collection as { repId?: string }).repId,
      actor,
    );
    (collection as { repId?: string }).repId = acting.repId ?? undefined;
    if (clientRef) {
      const existing = await this.inbox.findOne({ where: { clientRef } });
      if (existing) {
        return { id: existing.id, status: existing.status, error: existing.error };
      }
    }
    const row = await this.inbox.save(
      this.inbox.create({
        type: 'COLLECTION',
        clientRef: clientRef ?? null,
        repId: acting.repId,
        payload: collection as unknown as Record<string, unknown>,
        status: 'pending',
      }),
    );
    await this.promoteCollection(row);
    const fresh = await this.inbox.findOneByOrFail({ id: row.id });
    return { id: fresh.id, status: fresh.status, error: fresh.error };
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
      { status: 'posted', resultRef, error: null, processedAt: new Date() },
    );
  }

  private async markFailed(id: string, e: unknown): Promise<void> {
    const error = e instanceof Error ? e.message : String(e);
    this.logger.warn(`Inbox ${id} promotion failed: ${error}`);
    await this.inbox.update({ id }, { status: 'failed', error, processedAt: new Date() });
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
