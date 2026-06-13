import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VoucherInbox, InboxStatus } from './entities/voucher-inbox.entity';
import { VouchersService } from '../vouchers/vouchers.service';
import { CollectionsService } from '../collections/collections.service';
import { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import { CreateCollectionDto } from '../collections/dto/create-collection.dto';
import { SyncVoucherDto, SyncCollectionDto, ListInboxQueryDto } from './dto/sync.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(VoucherInbox)
    private readonly inbox: Repository<VoucherInbox>,
    private readonly vouchers: VouchersService,
    private readonly collections: CollectionsService,
  ) {}

  /**
   * Stage a voucher from the mobile app: dedupe by clientRef, assign an
   * authoritative number, then try to promote it into the main tables. The
   * assigned number is returned even if promotion fails (the row waits in the
   * inbox for retry) so the device always has a stable, conflict-free number.
   */
  async ingestVoucher(
    dto: SyncVoucherDto,
  ): Promise<{ id: string; voucherNumber: string; status: InboxStatus; error?: string | null }> {
    const { clientRef, ...voucher } = dto;

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
    const repId = await this.resolveRepId(voucher.userCode);
    const store = await this.resolveStore(voucher, repId);
    const assignedNumber = await this.vouchers.reserveVoucherNumber(
      voucher.transKind,
      store,
    );

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
  ): Promise<{ id: string; status: InboxStatus; error?: string | null }> {
    const { clientRef, ...collection } = dto;
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
        repId: (collection as { repId?: string }).repId ?? null,
        payload: collection as unknown as Record<string, unknown>,
        status: 'pending',
      }),
    );
    await this.promoteCollection(row);
    const fresh = await this.inbox.findOneByOrFail({ id: row.id });
    return { id: fresh.id, status: fresh.status, error: fresh.error };
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
