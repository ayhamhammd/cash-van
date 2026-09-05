import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { StockRequest, StockRequestStatus } from './entities/stock-request.entity';
import { StockRequestItem } from './entities/stock-request-item.entity';
import {
  ApproveStockRequestDto,
  CreateStockRequestDto,
  ListStockRequestsQueryDto,
} from './dto/stock-request.dto';
import { Rep } from '../reps/entities/rep.entity';
import { User } from '../users/entities/user.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { RepScopeService } from '../users/rep-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/** One message for every decision gate, so a refusal reads the same everywhere. */
const CANNOT_DECIDE = 'You are not allowed to decide stock requests.';

@Injectable()
export class StockRequestsService {
  private readonly logger = new Logger(StockRequestsService.name);

  constructor(
    @InjectRepository(StockRequest)
    private readonly repo: Repository<StockRequest>,
    @InjectRepository(StockRequestItem)
    private readonly itemsRepo: Repository<StockRequestItem>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Warehouse)
    private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(AppSettings)
    private readonly settings: Repository<AppSettings>,
    @InjectRepository(ItemCart)
    private readonly items: Repository<ItemCart>,
    @InjectRepository(ItemUnit)
    private readonly itemUnits: Repository<ItemUnit>,
    // The vouchers module already imports this one's siblings; break the cycle
    // the same way approvals does.
    @Inject(forwardRef(() => VouchersService))
    private readonly vouchers: VouchersService,
    // Deferred: erp-sync imports this module's entity, so the graph closes.
    @Inject(forwardRef(() => ErpOutboxService))
    private readonly erpOutbox: ErpOutboxService,
    @Inject(forwardRef(() => ErpSyncService))
    private readonly erpSync: ErpSyncService,
    private readonly repScope: RepScopeService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
    private readonly dataSource: DataSource,
  ) {}

  // ── Creation (mobile) ──────────────────────────────────────────────────────

  /**
   * A salesman asks for stock to be loaded onto their van.
   *
   * Item names and unit factors are snapshotted from the catalogue here rather
   * than trusted from the request body: the app sends what it last synced, which
   * can be days old, and the manager has to review what the item IS.
   */
  async create(dto: CreateStockRequestDto, user: AuthenticatedUser): Promise<StockRequest> {
    await this.assertCan(user, 'canRequestStock', 'You are not allowed to request stock.');
    const rep = await this.reps.findOne({ where: { userId: user.sub } });
    if (!rep) {
      throw new ForbiddenException('Only a salesman can request stock for a van');
    }
    if (!rep.vanId) {
      throw new BadRequestException('This salesman has no van store assigned');
    }
    const van = await this.warehouses.findOne({ where: { id: rep.vanId } });
    if (!van) {
      throw new BadRequestException('This salesman has no van store assigned');
    }

    // Two lines for the same pool would become two transfer lines for the same
    // pool — legal, but it reads as a mistake to the manager and doubles on
    // approval. Merge instead of rejecting: the salesman meant the total.
    const merged = new Map<string, { line: CreateStockRequestDto['items'][number]; qty: number }>();
    for (const line of dto.items) {
      const key = `${line.itemNumber}|${line.stockUnitCode ?? ''}|${line.unitBaseQty ?? 1}`;
      const seen = merged.get(key);
      if (seen) seen.qty += line.qtyOfUnit;
      else merged.set(key, { line, qty: line.qtyOfUnit });
    }

    const itemNumbers = [...new Set(dto.items.map((i) => i.itemNumber))];
    const catalogue = await this.items.find({ where: { itemNumber: In(itemNumbers) } });
    const byNumber = new Map(catalogue.map((i) => [i.itemNumber, i]));
    const missing = itemNumbers.filter((n) => !byNumber.has(n));
    if (missing.length) {
      throw new BadRequestException(`Unknown item(s): ${missing.join(', ')}`);
    }

    const vanQty = await this.vanQtyByPool(van.whNumber, itemNumbers);

    // A van load cannot draw more than the company depots actually hold. Vans are
    // sourced from ANY non-van depot (the manager picks the exact one at approval,
    // the main store only as the default), so availability here is the item's live
    // stock SUMMED ACROSS ALL DEPOTS — the same total the dashboard shows. Checking
    // one nominal "main store" wrongly rejected a request when the goods sat in
    // another depot. Skipped entirely if there are no depots (nothing to check).
    const depots = await this.depotStoreNumbers();
    const depotQty = await this.depotAvailabilityByPool(itemNumbers, depots);
    const over: string[] = [];
    for (const { line, qty } of merged.values()) {
      const factor = line.unitBaseQty && line.unitBaseQty > 0 ? line.unitBaseQty : 1;
      const pool = line.stockUnitCode ?? '';
      const requestedBase = qty * factor;
      const available = depotQty.get(`${line.itemNumber}|${pool}`) ?? 0;
      if (depots.length > 0 && requestedBase > available + 1e-6) {
        const name = byNumber.get(line.itemNumber)?.nameAr ?? line.itemNumber;
        over.push(`${name}: طلب ${requestedBase} / المتوفر ${available}`);
      }
    }
    if (over.length) {
      throw new BadRequestException({
        message: `الكمية المطلوبة تتجاوز المتوفر في المستودعات: ${over.join('؛ ')}`,
        code: 'STOCK_REQUEST_EXCEEDS_AVAILABLE',
        store: null,
        items: over,
      });
    }

    const rows: StockRequestItem[] = [];
    for (const { line, qty } of merged.values()) {
      const item = byNumber.get(line.itemNumber)!;
      const factor = line.unitBaseQty && line.unitBaseQty > 0 ? line.unitBaseQty : 1;
      const pool = line.stockUnitCode ?? '';
      rows.push(
        this.itemsRepo.create({
          itemNumber: item.itemNumber,
          itemName: item.nameAr ?? item.nameEn ?? item.itemNumber,
          stockUnitCode: pool,
          itemUnitId: line.itemUnitId ?? null,
          unitName: line.unitName ?? null,
          unitBaseQty: factor,
          qtyOfUnit: qty.toFixed(3),
          baseQty: (qty * factor).toFixed(3),
          vanQtyAtRequest: (vanQty.get(`${item.itemNumber}|${pool}`) ?? 0).toFixed(3),
        }),
      );
    }

    const saved = await this.repo.save(
      this.repo.create({
        requestNumber: await this.nextRequestNumber(),
        status: 'pending',
        requesterUser: user.sub,
        repId: rep.id,
        vanStoreNumber: van.whNumber,
        note: dto.note ?? null,
        items: rows,
      }),
    );

    await this.announceRequested(saved, rep);
    return this.findOneOrThrow(saved.id);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * @param visibleRepIds null = unrestricted; an array (possibly empty) limits
   *   the queue to those reps. See docs/SPEC-rep-scoped-users.md.
   */
  async list(
    q: ListStockRequestsQueryDto,
    visibleRepIds: string[] | null = null,
  ): Promise<{ items: StockRequest[]; total: number }> {
    // Intersect the caller's filter with what they are allowed to see, rather
    // than letting one key overwrite the other in the object literal. A scoped
    // manager asking for a rep outside their scope gets nothing, not their whole
    // scope — and their filter still applies when the rep IS in it.
    let repFilter: string[] | string | null = null;
    if (visibleRepIds !== null) {
      const allowed = q.repId
        ? visibleRepIds.filter((id) => id === q.repId)
        : visibleRepIds;
      if (allowed.length === 0) return { items: [], total: 0 };
      repFilter = allowed;
    } else if (q.repId) {
      repFilter = q.repId;
    }

    const [items, total] = await this.repo.findAndCount({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(repFilter !== null
          ? { repId: Array.isArray(repFilter) ? In(repFilter) : repFilter }
          : {}),
      },
      relations: { items: true },
      order: { createdAt: 'DESC' },
      skip: q.offset ?? 0,
      take: q.limit ?? 25,
    });
    return { items, total };
  }

  async findOne(id: string, user?: AuthenticatedUser): Promise<StockRequest> {
    const row = await this.findOneOrThrow(id);
    if (user && row.repId) await this.repScope.assertCanSeeRep(user, row.repId);
    return row;
  }

  /** The requester's own requests — what the app polls while it waits. */
  async listMine(userId: string, limit = 25): Promise<StockRequest[]> {
    return this.repo.find({
      where: { requesterUser: userId },
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ── Decisions (dashboard) ─────────────────────────────────────────────────

  /**
   * Approve, granting either what was asked or less, per line.
   *
   * Approval does NOT move van stock. The goods are still in the warehouse at
   * this point; the van's stock changes when the salesman confirms they have
   * them ([markReceived]). Moving it here would show stock on a van that is
   * physically empty, and every sale against it would fail at the stock check.
   */
  async approve(
    id: string,
    dto: ApproveStockRequestDto,
    reviewer: AuthenticatedUser,
  ): Promise<StockRequest> {
    await this.assertCan(reviewer, 'canApproveStockRequest', CANNOT_DECIDE);
    const row = await this.findOneOrThrow(id);
    if (row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }

    const source = await this.warehouses.findOne({
      where: { whNumber: dto.sourceStoreNumber },
    });
    if (!source) {
      throw new BadRequestException(`Unknown warehouse ${dto.sourceStoreNumber}`);
    }
    if (source.whNumber === row.vanStoreNumber) {
      throw new BadRequestException('Source and destination are the same store');
    }

    const granted = new Map((dto.lines ?? []).map((l) => [l.id, l.approvedBaseQty]));
    const unknown = [...granted.keys()].filter((k) => !row.items.some((i) => i.id === k));
    if (unknown.length) {
      throw new BadRequestException(`Line(s) not on this request: ${unknown.join(', ')}`);
    }

    // The SOURCE store's live stock, re-read at approval — it may have dropped
    // since the request was raised, so a grant is capped against what the depot
    // holds NOW, not what it held then. Base units, keyed by pool.
    const sourceQty = await this.warehouseQtyByPool(
      source.whNumber,
      [...new Set(row.items.map((i) => i.itemNumber))],
    );

    const overSource: string[] = [];
    for (const item of row.items) {
      const asked = Number(item.baseQty);
      // A line the reviewer did not touch is granted in full — approving exactly
      // what was asked is the common case and should need no per-line input.
      const give = granted.has(item.id) ? granted.get(item.id)! : asked;
      if (give > asked) {
        throw new BadRequestException(
          `Cannot approve more than requested for ${item.itemName} (asked ${asked}, granted ${give})`,
        );
      }
      const available = sourceQty.get(`${item.itemNumber}|${item.stockUnitCode ?? ''}`) ?? 0;
      if (give > available + 1e-6) {
        overSource.push(`${item.itemName}: منح ${give} / المتوفر ${available}`);
      }
      item.approvedBaseQty = give.toFixed(3);
    }
    if (overSource.length) {
      throw new BadRequestException({
        message: `الكمية الممنوحة تتجاوز رصيد المستودع ${source.whName ?? source.whNumber}: ${overSource.join('؛ ')}`,
        code: 'STOCK_REQUEST_APPROVE_EXCEEDS_SOURCE',
        store: source.whNumber,
        items: overSource,
      });
    }

    if (row.items.every((i) => Number(i.approvedBaseQty) === 0)) {
      throw new BadRequestException(
        'Every line was zeroed — reject the request instead, so the salesman gets a reason',
      );
    }

    await this.dataSource.transaction(async (m) => {
      await m.save(StockRequestItem, row.items);
      row.status = 'approved';
      row.sourceStoreNumber = source.whNumber;
      row.reviewerUser = reviewer.sub;
      row.decisionNote = dto.note ?? null;
      row.decidedAt = new Date();
      await m.save(StockRequest, row);
    });

    // Tell the ERP what the warehouse now owes this van. Best-effort by design:
    // the outbox retries on its own, and a queue failure must not undo an
    // approval the manager already made.
    await this.erpOutbox.enqueue('VAN_STOCK_REQUEST', row.id);

    await this.announceDecided(row);
    return this.findOneOrThrow(row.id);
  }

  async reject(
    id: string,
    reason: string,
    reviewer: AuthenticatedUser,
  ): Promise<StockRequest> {
    await this.assertCan(reviewer, 'canApproveStockRequest', CANNOT_DECIDE);
    const row = await this.findOneOrThrow(id);
    if (row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }
    row.status = 'rejected';
    row.reviewerUser = reviewer.sub;
    row.decisionNote = reason;
    row.decidedAt = new Date();
    await this.repo.save(row);

    await this.announceDecided(row);
    return row;
  }

  /** The requester withdraws their own still-pending request. */
  async cancel(id: string, requesterUserId: string): Promise<StockRequest> {
    const row = await this.findOneOrThrow(id);
    if (row.requesterUser !== requesterUserId) {
      throw new ForbiddenException('You can only cancel your own request');
    }
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }
    row.status = 'cancelled';
    row.decidedAt = new Date();
    await this.repo.save(row);
    return row;
  }

  /**
   * The salesman confirms the goods are on the van. THIS is what moves stock.
   *
   * Raises a single TRANSFER voucher (source → van). That voucher is what the
   * existing outbox pushes to the ERP, so the movement reaches accounting by the
   * same route as every other van document rather than a private one.
   */
  async markReceived(id: string, user: AuthenticatedUser): Promise<StockRequest> {
    const row = await this.findOneOrThrow(id);
    if (row.requesterUser !== user.sub) {
      throw new ForbiddenException('Only the requester can confirm receipt');
    }
    if (row.status !== 'approved') {
      throw new ConflictException(
        row.status === 'received'
          ? 'This request was already received'
          : `Cannot receive a request that is ${row.status}`,
      );
    }
    if (!row.sourceStoreNumber) {
      throw new ConflictException('Approved request has no source warehouse');
    }

    const lines = row.items.filter((i) => Number(i.approvedBaseQty ?? 0) > 0);
    if (!lines.length) {
      throw new ConflictException('Nothing was approved on this request');
    }

    const rep = row.repId ? await this.reps.findOne({ where: { id: row.repId } }) : null;

    // The voucher's itemQty is a quantity in the line's CHOSEN unit, and the
    // service multiplies it by the unit factor it resolves itself. Approved
    // quantities here are in POOL units, so they have to be divided back — or
    // 18 pieces are received as 18 cartons. Sending no unit at all yields a
    // factor of 1, which is exactly right for a base-pool line.
    const transactions = await Promise.all(
      lines.map(async (i) => {
        const approved = Number(i.approvedBaseQty);
        const base = {
          itemNumber: i.itemNumber,
          itemName: i.itemName,
          unitPrice: '0',
          fromStoreNumber: row.sourceStoreNumber!,
          toStoreNumber: row.vanStoreNumber,
        };
        // Base pool: move the approved pieces as-is, with no unit to re-scale them.
        if (!i.stockUnitCode || !i.itemUnitId) {
          return { ...base, itemQty: approved.toFixed(3) };
        }
        // Variant pool: the unit must travel with the line or the goods land in
        // the item's base pool. Factor comes from item_units, never from the
        // snapshot — the voucher service resolves the same row and would
        // disagree with a stale one.
        const iu = await this.itemUnits.findOne({ where: { id: i.itemUnitId } });
        const factor = iu && iu.qty > 0 ? iu.qty : 1;
        return {
          ...base,
          itemUnitId: i.itemUnitId,
          unitName: i.unitName ?? undefined,
          itemQty: (approved / factor).toFixed(3),
        };
      }),
    );

    const created = await this.vouchers.create({
      transKind: 'TRANSFER',
      userCode: rep?.code ?? user.sub,
      isPosted: true,
      transactions,
    } as CreateVoucherDto);

    row.status = 'received';
    row.receivedAt = new Date();
    row.transferVoucherNumber = created.voucherNumber;
    await this.repo.save(row);

    this.events.emit('stock-request.received', {
      id: row.id,
      requestNumber: row.requestNumber,
      repId: row.repId,
      voucherNumber: created.voucherNumber,
    });
    return this.findOneOrThrow(row.id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Hide a decided request from the queue without destroying it.
   *
   * Only requests that never moved stock. An approved-and-received one is the
   * paperwork behind a real transfer voucher, and hiding it would leave that
   * voucher with nothing explaining why it exists.
   */
  async softDelete(id: string, user: AuthenticatedUser): Promise<{ id: string }> {
    await this.assertCan(user, 'canApproveStockRequest', CANNOT_DECIDE);
    const row = await this.findOneOrThrow(id);
    if (row.repId) await this.repScope.assertCanSeeRep(user, row.repId);
    if (row.status === 'pending') {
      throw new ConflictException(
        'Decide the request first — rejecting it tells the salesman why, deleting it does not.',
      );
    }
    if (row.status === 'received' || row.transferVoucherNumber) {
      throw new ConflictException(
        `Cannot delete ${row.requestNumber}: stock moved against it${
          row.transferVoucherNumber ? ` on voucher ${row.transferVoucherNumber}` : ''
        }.`,
      );
    }
    await this.repo.softDelete(id);
    return { id };
  }

  /**
   * Record that the office raised the transfer for an approved request.
   *
   * Called when a transfer voucher is posted against a request from the
   * dashboard or the ERP. It closes the request the same way the van's own
   * receipt does — because the goods have already moved, and leaving it open
   * would let [markReceived] raise a SECOND transfer for the same lines.
   */
  async attachTransfer(
    id: string,
    voucherNumber: string,
    user: AuthenticatedUser,
  ): Promise<StockRequest> {
    await this.assertCan(user, 'canApproveStockRequest', CANNOT_DECIDE);
    const row = await this.findOneOrThrow(id);
    if (row.repId) await this.repScope.assertCanSeeRep(user, row.repId);
    if (row.status !== 'approved') {
      throw new ConflictException(
        `Only an approved request can be fulfilled by a transfer; ${row.requestNumber} is ${row.status}.`,
      );
    }
    row.status = 'received';
    row.receivedAt = new Date();
    row.transferVoucherNumber = voucherNumber;
    await this.repo.save(row);

    // The rep is waiting on this: their van's stock just changed and the button
    // they were going to press has gone away.
    await this.notifications.notifyUser(row.requesterUser, {
      kind: 'stock-request.decided',
      titleAr: `تم تحميل طلب البضاعة ${row.requestNumber} — سند ${voucherNumber}`,
      titleEn: `Stock request ${row.requestNumber} loaded — voucher ${voucherNumber}`,
      refType: 'stock-request',
      refId: row.id,
    });
    this.events.emit('stock-request.received', {
      id: row.id,
      requestNumber: row.requestNumber,
      repId: row.repId,
      voucherNumber,
    });
    return this.findOneOrThrow(row.id);
  }

  /**
   * Per-user capability check.
   *
   * Read from the DATABASE, not from the token's permissions map: a JWT lives
   * for hours, so a permission revoked this morning would keep working until
   * the user happened to log in again. An admin passes everything, which is the
   * same rule the voucher policy uses.
   */
  private async assertCan(
    user: AuthenticatedUser,
    flag: 'canRequestStock' | 'canApproveStockRequest',
    message: string,
  ): Promise<void> {
    if (user.role === 'admin' || user.userType === 'ADMIN') return;
    const row = await this.users.findOne({ where: { id: user.sub } });
    if (!row?.[flag]) throw new ForbiddenException(message);
  }

  private async findOneOrThrow(id: string): Promise<StockRequest> {
    const row = await this.repo.findOne({ where: { id }, relations: { items: true } });
    if (!row) throw new NotFoundException(`Stock request ${id} not found`);
    return row;
  }

  /**
   * Van stock per pool, keyed `itemNumber|stockUnitCode`.
   *
   * Read straight from the posted-voucher balance ledger — the same source the
   * sale-time stock check uses. A second, cleverer source here would eventually
   * disagree with the one that blocks sales.
   */

  /**
   * Requestable availability per pool for the request UIs to show and for create()
   * to reject an over-request. SUMMED ACROSS ALL non-van depots — a van is sourced
   * from any depot (main store is only the default), so this is the total the item
   * has to give, matching what the dashboard shows. Prefers the ERP's authoritative
   * on-hand; falls back to the local ledger. `storeNumber` is null because this is
   * an aggregate, not one store; the default source depot is chosen at approval.
   */
  /**
   * The MAIN warehouse van loads are requested from. Mirrors MobileService's
   * resolver so the requesting-inventory picker and the ORDER flow agree on the
   * same store: the admin-configured `main_store_number` wins, else the store the
   * ERP flags as main (`is_main`, re-mirrored every sync), else the lowest-numbered
   * depot. Null only when no depot exists at all.
   */
  private async resolveMainStore(): Promise<{ number: string; name: string | null } | null> {
    const cfg = await this.settings.findOne({ where: { id: 1 } });
    if (cfg?.mainStoreNumber) {
      const wh = await this.warehouses.findOne({ where: { whNumber: cfg.mainStoreNumber } });
      return { number: cfg.mainStoreNumber, name: wh?.whName ?? null };
    }
    const flagged = await this.warehouses.findOne({ where: { isMain: true, isVan: false } });
    if (flagged) return { number: flagged.whNumber, name: flagged.whName ?? null };
    const depots = await this.warehouses.find({ where: { isVan: false } });
    if (!depots.length) return null;
    const first = [...depots].sort((a, b) =>
      a.whNumber.localeCompare(b.whNumber, undefined, { numeric: true }),
    )[0];
    return { number: first.whNumber, name: first.whName ?? null };
  }

  async mainStoreStock(): Promise<{
    storeNumber: string | null;
    storeName: string | null;
    items: Array<{ itemNumber: string; stockUnitCode: string; qty: number }>;
  }> {
    // Only the MAIN warehouse — not every depot. The requesting-inventory picker
    // must show the main store's own on-hand and ONLY the items it actually
    // carries, so a rep cannot see (or request against) stock sitting in some
    // other depot. Resolves the same main store the ORDER flow uses.
    const main = await this.resolveMainStore();
    if (!main) return { storeNumber: null, storeName: null, items: [] };
    // Live ERP on-hand for the main store — the book of record for QUANTITY. But
    // its snapshot silently drops any SKU it can't map, and on 94 the ERP's
    // item_stock has drifted (items with no item_stock row vanish from /van/stock,
    // others read 0). So it is used for quantity, NOT membership — mirroring
    // getOrderStock (fix 07e8abf), which had this same missing-items bug.
    const live = await this.erpSync
      .liveErpStock({ stockNumber: main.number })
      .catch(() => null);
    const liveQty = new Map<string, number>();
    if (live && live.source === 'erp') {
      for (const r of live.rows) {
        if (r.stockNumber !== main.number) continue;
        const key = `${r.itemNumber}|${r.stockUnitCode ?? ''}`;
        liveQty.set(key, (liveQty.get(key) ?? 0) + r.quantity);
      }
    }

    // The local ledger is the COMPLETE membership for the main store — it never
    // drops an item the live snapshot couldn't map. Base the list on it and
    // overlay the live quantity where we have it (live wins on quantity, and
    // contributes any pool not yet booked locally).
    const ledgerRows: Array<{ item_number: string; stock_unit_code: string | null; qty: string }> =
      await this.dataSource.query(
        `SELECT item_number, stock_unit_code, SUM(qty) AS qty
           FROM item_balance
          WHERE stock_number = $1
          GROUP BY item_number, stock_unit_code`,
        [main.number],
      );

    const agg = new Map<string, { itemNumber: string; stockUnitCode: string; qty: number }>();
    for (const r of ledgerRows) {
      const pool = r.stock_unit_code ?? '';
      agg.set(`${r.item_number}|${pool}`, {
        itemNumber: r.item_number,
        stockUnitCode: pool,
        qty: Number(r.qty) || 0,
      });
    }
    for (const [key, qty] of liveQty) {
      const sep = key.indexOf('|');
      agg.set(key, { itemNumber: key.slice(0, sep), stockUnitCode: key.slice(sep + 1), qty });
    }

    return {
      storeNumber: main.number,
      storeName: main.name,
      items: [...agg.values()].filter((i) => i.qty !== 0),
    };
  }

  private async vanQtyByPool(
    storeNumber: string,
    itemNumbers: string[],
  ): Promise<Map<string, number>> {
    if (!itemNumbers.length) return new Map();
    const rows: Array<{ item_number: string; stock_unit_code: string | null; qty: string }> =
      await this.dataSource.query(
        `SELECT item_number, stock_unit_code, qty
           FROM item_balance
          WHERE stock_number = $1 AND item_number = ANY($2::text[])`,
        [storeNumber, itemNumbers],
      );
    return new Map(
      rows.map((r) => [`${r.item_number}|${r.stock_unit_code ?? ''}`, Number(r.qty) || 0]),
    );
  }

  /**
   * On-hand per pool for a WAREHOUSE store (the main store, or an approval's
   * source depot), keyed `${itemNumber}|${stockUnitCode}` in base units — the same
   * shape as vanQtyByPool. Prefers the ERP's authoritative on-hand (the book of
   * record) so a request/approval is validated against real stock, not the local
   * summed-delta ledger, which can drift. Falls back to the local ledger when the
   * ERP is unavailable, and NEVER reads live for a van store (its own sales lag the
   * ERP — that would be the overselling trap), so this is safe for any store.
   */
  private async warehouseQtyByPool(
    storeNumber: string,
    itemNumbers: string[],
  ): Promise<Map<string, number>> {
    if (!itemNumbers.length) return new Map();
    const vans = await this.erpSync.vanStoreNumbers().catch(() => new Set<string>());
    if (!vans.has(storeNumber)) {
      // Broad snapshot filtered to this store + items — the targeted mode depends
      // on item_units.erp_sku_code, which is not always mapped and then reads as
      // "0 available", wrongly blocking an approval for stock that exists.
      const itemSet = new Set(itemNumbers);
      const live = await this.erpSync.liveErpStock({}).catch(() => null);
      if (live && live.source === 'erp') {
        const m = new Map<string, number>();
        for (const r of live.rows) {
          if (r.stockNumber !== storeNumber || !itemSet.has(r.itemNumber)) continue;
          m.set(`${r.itemNumber}|${r.stockUnitCode}`, r.quantity);
        }
        return m;
      }
    }
    // Van store, or ERP unavailable → the local ledger.
    return this.vanQtyByPool(storeNumber, itemNumbers);
  }

  /** Every non-van depot's store number — the stores a van load may be sourced from. */
  private async depotStoreNumbers(): Promise<string[]> {
    const depots = await this.warehouses.find({ where: { isVan: false } });
    return depots.map((d) => d.whNumber).filter((n): n is string => !!n);
  }

  /**
   * Requestable availability per pool, SUMMED across ALL non-van depots — not just
   * the default "main store". A van may be sourced from ANY depot at approval, so a
   * request must not be blocked because the nominal main store is empty when the
   * goods sit in another depot (which is exactly what the dashboard shows). Prefers
   * live ERP (the book of record); falls back to the local ledger summed per pool.
   */
  private async depotAvailabilityByPool(
    itemNumbers: string[],
    depots: string[],
  ): Promise<Map<string, number>> {
    if (!itemNumbers.length || depots.length === 0) return new Map();
    const depotSet = new Set(depots);
    const itemSet = new Set(itemNumbers);
    const out = new Map<string, number>();

    // Use the BROAD ERP snapshot (all stores), filtered to the requested items and
    // depots. The targeted mode resolves each item's ERP sku code from item_units,
    // which is not always mapped — a missing mapping there returned an empty result
    // and wrongly read as "0 available", rejecting a request for stock that exists.
    // The broad snapshot maps by the ERP's own sku code, the same way the dashboard
    // and mainStoreStock do, so it agrees with what the UI shows.
    const live = await this.erpSync.liveErpStock({}).catch(() => null);
    if (live && live.source === 'erp') {
      for (const r of live.rows) {
        if (!depotSet.has(r.stockNumber) || !itemSet.has(r.itemNumber)) continue;
        const key = `${r.itemNumber}|${r.stockUnitCode}`;
        out.set(key, (out.get(key) ?? 0) + r.quantity);
      }
      return out;
    }

    const rows: Array<{ item_number: string; stock_unit_code: string | null; qty: string }> =
      await this.dataSource.query(
        `SELECT item_number, stock_unit_code, SUM(qty) AS qty
           FROM item_balance
          WHERE stock_number = ANY($1::text[]) AND item_number = ANY($2::text[])
          GROUP BY item_number, stock_unit_code`,
        [depots, itemNumbers],
      );
    for (const r of rows) {
      out.set(`${r.item_number}|${r.stock_unit_code ?? ''}`, Number(r.qty) || 0);
    }
    return out;
  }

  /**
   * SR-000001, SR-000002 …
   *
   * Derived from the current maximum rather than a sequence object so it stays
   * correct if rows are ever imported. Collisions are caught by the unique index
   * on request_number, not prevented here.
   */
  private async nextRequestNumber(): Promise<string> {
    const [row]: Array<{ max: string | null }> = await this.dataSource.query(
      `SELECT MAX(NULLIF(regexp_replace(request_number, '\\D', '', 'g'), '')::bigint)::text AS max
         FROM stock_requests`,
    );
    const next = (Number(row?.max ?? 0) || 0) + 1;
    return `SR-${String(next).padStart(6, '0')}`;
  }

  private async announceRequested(row: StockRequest, rep: Rep): Promise<void> {
    const requester = await this.users.findOne({ where: { id: row.requesterUser } });
    const repName = rep.nameAr ?? requester?.name ?? requester?.userNumber ?? '—';
    const count = row.items.length;

    await this.notifications.notifyManagers(
      {
        kind: 'stock-request.requested',
        titleAr: `طلب بضاعة جديد من ${repName} (${count} صنف)`,
        titleEn: `Stock request from ${repName} (${count} item${count === 1 ? '' : 's'})`,
        bodyAr: row.note ?? undefined,
        bodyEn: row.note ?? undefined,
        refType: 'stock-request',
        refId: row.id,
      },
      row.requesterUser,
    );

    this.events.emit('stock-request.requested', {
      id: row.id,
      requestNumber: row.requestNumber,
      repId: row.repId,
      repName,
      itemCount: count,
      createdAt: row.createdAt,
    });
  }

  private async announceDecided(row: StockRequest): Promise<void> {
    const approved = row.status === 'approved';
    // A partial grant is the case a salesman most needs told plainly — they are
    // planning a route around what is on the van.
    const short = row.items.filter(
      (i) => i.approvedBaseQty != null && Number(i.approvedBaseQty) < Number(i.baseQty),
    ).length;

    await this.notifications.notifyUser(row.requesterUser, {
      kind: 'stock-request.decided',
      titleAr: approved
        ? short > 0
          ? `تمت الموافقة جزئيًا على طلب البضاعة ${row.requestNumber} (${short} صنف بكمية أقل)`
          : `تمت الموافقة على طلب البضاعة ${row.requestNumber}`
        : `تم رفض طلب البضاعة ${row.requestNumber}`,
      titleEn: approved
        ? short > 0
          ? `Stock request ${row.requestNumber} partly approved (${short} line${short === 1 ? '' : 's'} reduced)`
          : `Stock request ${row.requestNumber} approved`
        : `Stock request ${row.requestNumber} rejected`,
      bodyAr: row.decisionNote ?? undefined,
      bodyEn: row.decisionNote ?? undefined,
      refType: 'stock-request',
      refId: row.id,
    });

    this.events.emit('stock-request.decided', {
      id: row.id,
      requestNumber: row.requestNumber,
      status: row.status,
      repId: row.repId,
      requesterUser: row.requesterUser,
      decisionNote: row.decisionNote ?? null,
    });
  }
}
