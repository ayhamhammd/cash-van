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
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { RepScopeService } from '../users/rep-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

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
      item.approvedBaseQty = give.toFixed(3);
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
