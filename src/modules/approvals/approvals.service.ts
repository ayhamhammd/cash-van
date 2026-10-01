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
import { In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  ApprovalRequest,
  ApprovalStatus,
  ApprovalType,
} from './entities/approval-request.entity';
import { CreateApprovalDto, ListApprovalsQueryDto } from './dto/approvals.dto';
import { VouchersService } from '../vouchers/vouchers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateVoucherDto } from '../vouchers/dto/create-voucher.dto';
import { Rep } from '../reps/entities/rep.entity';
import { User } from '../users/entities/user.entity';
import { RepScopeService } from '../users/rep-scope.service';
import { CustomersService } from '../customers/customers.service';
import { CreateCustomerDto } from '../customers/dto/create-customer.dto';
import { PendingCustomerPhoto } from '../customers/entities/pending-customer-photo.entity';
import { Customer } from '../customers/entities/customer.entity';
import { PERM_CREDIT_REQUEST } from '../../common/constants/permissions';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const TYPE_LABEL: Record<ApprovalType, { ar: string; en: string }> = {
  RETURN_VOUCHER: { ar: 'مرتجع', en: 'Return' },
  VOUCHER_DISCOUNT: { ar: 'خصم', en: 'Discount' },
  PRICE_OVERRIDE: { ar: 'تغيير سعر', en: 'Price change' },
  CUSTOMER_CREATE: { ar: 'إضافة عميل', en: 'New customer' },
  VOUCHER_FREE_ITEM: { ar: 'أصناف مجانية', en: 'Free items' },
  CREDIT_OVER_LIMIT: { ar: 'بيع آجل فوق حد الائتمان', en: 'Credit over limit' },
};

/** What a supervisor may decide: new customers, and credit for their own reps. */
const SUPERVISOR_TYPES: ApprovalType[] = ['CUSTOMER_CREATE', 'CREDIT_OVER_LIMIT'];

/** An approval row as the queue shows it: who asked, for whom. */
export type ApprovalRow = ApprovalRequest & { repName: string | null; customerName: string | null };

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @InjectRepository(ApprovalRequest)
    private readonly repo: Repository<ApprovalRequest>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @Inject(forwardRef(() => VouchersService))
    private readonly vouchers: VouchersService,
    // forwardRef both ways: customers files the request, approvals executes it.
    @Inject(forwardRef(() => CustomersService))
    private readonly customers: CustomersService,
    @InjectRepository(PendingCustomerPhoto)
    private readonly pendingPhotos: Repository<PendingCustomerPhoto>,
    @InjectRepository(Customer)
    private readonly customerRows: Repository<Customer>,
    private readonly repScope: RepScopeService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * A salesman without canCreateCustomerDirect submits a customer for review.
   *
   * Separate from [create] because that one validates a VOUCHER payload — this
   * payload is a customer, and running it through voucher validation would
   * reject every request. Managers are notified the same way.
   */
  async createCustomerRequest(
    dto: CreateCustomerDto,
    user: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const requester = await this.users.findOne({ where: { id: user.sub } });
    const rep = await this.reps.findOne({ where: { userId: user.sub } });

    // Carry the photo's URL in the payload, not just its id: the reviewer has to
    // SEE the document to judge the request, and an id alone would cost the
    // dashboard a lookup per row.
    const photo = dto.photoId
      ? await this.pendingPhotos.findOne({ where: { id: dto.photoId } })
      : null;

    const row = await this.repo.save(
      this.repo.create({
        type: 'CUSTOMER_CREATE',
        requesterUser: user.sub,
        repId: rep?.id ?? null,
        customerNumber: dto.customerNumber ?? null,
        payload: {
          ...(dto as unknown as Record<string, unknown>),
          photoUrl: photo?.url ?? null,
        },
        note: dto.customerName ?? dto.nameAr ?? null,
      }),
    );

    const repName = rep?.nameAr ?? requester?.name ?? requester?.userNumber ?? '—';
    const who = dto.nameAr ?? dto.customerName ?? '—';
    await this.notifications.notifyManagers({
      kind: 'approval.requested',
      titleAr: `طلب إضافة عميل «${who}» من ${repName}`,
      titleEn: `New customer request "${who}" from ${repName}`,
      refType: 'approval',
      refId: row.id,
    });
    // Same event the voucher path emits — this is what reaches the dashboard over
    // the ops socket. Without it a customer request would only ever appear on a
    // manual refresh, and the rep is standing in the shop waiting for it.
    this.events.emit('approval.requested', {
      id: row.id,
      type: row.type,
      repId: row.repId,
      repName,
      customerNumber: row.customerNumber,
      createdAt: row.createdAt,
    });
    return row;
  }

  /** Salesman files a request; managers are notified instantly. */
  async create(requesterUserId: string, dto: CreateApprovalDto): Promise<ApprovalRequest> {
    // Validate the embedded voucher payload NOW so managers never review garbage
    // that would fail at execution time.
    await this.validateVoucherPayload(dto.payload);

    const requester = await this.users.findOne({ where: { id: requesterUserId } });
    const rep = await this.reps.findOne({ where: { userId: requesterUserId } });
    const customerNumber =
      dto.customerNumber ??
      ((dto.payload as { customerNumber?: string }).customerNumber || null);
    const context =
      dto.type === 'CREDIT_OVER_LIMIT'
        ? await this.creditContext(requester, customerNumber, dto.payload)
        : null;

    const row = await this.repo.save(
      this.repo.create({
        type: dto.type,
        requesterUser: requesterUserId,
        repId: rep?.id ?? null,
        customerNumber,
        payload: dto.payload,
        note: dto.note ?? null,
        context,
      }),
    );

    const repName = rep?.nameAr ?? requester?.name ?? requester?.userNumber ?? '—';
    const label = TYPE_LABEL[dto.type];
    await this.notifications.notifyManagers(
      {
        kind: 'approval.requested',
        titleAr: `طلب ${label.ar} جديد من ${repName}`,
        titleEn: `New ${label.en.toLowerCase()} request from ${repName}`,
        // A credit request names the customer and the amount in the notification
        // itself: the supervisor decides from the bell, not after opening it.
        bodyAr: context
          ? [`${context.customerName} — ${Number(context.creditAmount).toFixed(3)}`, dto.note].filter(Boolean).join('\n')
          : dto.note ?? undefined,
        bodyEn: context
          ? [`${context.customerName} — ${Number(context.creditAmount).toFixed(3)}`, dto.note].filter(Boolean).join('\n')
          : dto.note ?? undefined,
        refType: 'approval',
        refId: row.id,
      },
      requesterUserId,
    );
    this.events.emit('approval.requested', {
      id: row.id,
      type: row.type,
      repId: row.repId,
      repName,
      customerNumber: row.customerNumber,
      createdAt: row.createdAt,
    });
    return row;
  }

  /**
   * @param visibleRepIds null = unrestricted; an array (possibly empty) limits
   *   the queue to requests from those reps. See docs/SPEC-rep-scoped-users.md.
   */
  async list(
    q: ListApprovalsQueryDto,
    visibleRepIds: string[] | null = null,
  ): Promise<{ items: ApprovalRequest[]; total: number }> {
    const [items, total] = await this.repo.findAndCount({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
        // In() of an empty array yields "IN (NULL)" — matches nothing, which is
        // exactly right for a scoped user with no salesmen assigned.
        ...(visibleRepIds !== null ? { repId: In(visibleRepIds) } : {}),
      },
      order: { createdAt: 'DESC' },
      skip: q.offset ?? 0,
      take: q.limit ?? 25,
    });
    return { items: await this.withNames(items), total };
  }

  /**
   * Who asked, and for whom, by NAME. The queue showed a customer number and no
   * salesman at all, so a supervisor deciding credit had to look both up.
   */
  private async withNames(rows: ApprovalRequest[]): Promise<ApprovalRow[]> {
    const repIds = [...new Set(rows.map((r) => r.repId).filter((x): x is string => !!x))];
    const numbers = [...new Set(rows.map((r) => r.customerNumber).filter((x): x is string => !!x))];
    const [reps, customers] = await Promise.all([
      repIds.length ? this.reps.find({ where: { id: In(repIds) } }) : Promise.resolve([] as Rep[]),
      numbers.length
        ? this.customerRows.find({ where: { customerNumber: In(numbers) }, withDeleted: true })
        : Promise.resolve([] as Customer[]),
    ]);
    const repName = new Map(reps.map((r) => [r.id, r.nameAr ?? r.nameEn ?? r.code ?? null]));
    const customerName = new Map(
      customers.map((c) => [c.customerNumber, c.nameAr || c.customerName || null]),
    );
    return rows.map((r) =>
      Object.assign(r, {
        repName: (r.repId && repName.get(r.repId)) || null,
        customerName: (r.customerNumber && customerName.get(r.customerNumber)) || null,
      }),
    );
  }

  /** The salesman's own requests (mobile polls this). */
  async mine(
    requesterUserId: string,
    status?: ApprovalStatus,
  ): Promise<ApprovalRequest[]> {
    return this.repo.find({
      where: { requesterUser: requesterUserId, ...(status ? { status } : {}) },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async findOneOrThrow(id: string): Promise<ApprovalRequest> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Approval request ${id} not found`);
    return row;
  }

  /**
   * One request, as the person asking is allowed to see it.
   *
   * The unscoped [findOneOrThrow] is still what the internal callers use. This
   * is for the HTTP route, which had no scope check at all: the LIST was
   * filtered to a supervisor's own salesmen and the DETAIL was not, so anyone
   * who could reach the queue could read any request by id. It did not matter
   * while only admins and managers could reach it. It matters now.
   */
  async findOneForReviewer(
    id: string,
    reviewer: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    if (row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
    this.assertReviewerMayDecide(reviewer, row);
    const [named] = await this.withNames([row]);
    return named;
  }

  /**
   * A supervisor reviews their salesmen's NEW CUSTOMERS, and nothing else.
   *
   * They were given the approvals queue so a new shop does not wait for head
   * office — the person who knows whether that shop is real is the one whose
   * reps call on it. The rest of the queue is money: a discount, a price
   * override, a return. Those stay with admin and manager until somebody asks
   * for the opposite, because widening this is one entry in a list and
   * narrowing it again after a supervisor has approved their own team's
   * discounts is not.
   *
   * Scope is enforced separately by assertCanSeeRep — this is about WHAT, that
   * is about WHOSE.
   */
  private assertReviewerMayDecide(
    reviewer: AuthenticatedUser,
    row: ApprovalRequest,
  ): void {
    if (reviewer.role !== 'supervisor') return;
    // Credit over the limit is the supervisor's call by design: the request is
    // literally "ask my supervisor to let this sale go on credit".
    if (!SUPERVISOR_TYPES.includes(row.type)) {
      throw new ForbiddenException(
        'A supervisor may only decide new-customer and credit requests',
      );
    }
  }

  /**
   * Approve → execute the stored voucher payload verbatim. Runs as the
   * reviewing manager (their CLS context), so the salesman-permission gate in
   * VouchersService passes; attribution stays with the rep via payload.userCode.
   */
  /**
   * A supervisor cuts (or clears) a requested free quantity before agreeing.
   *
   * WHY THE WHOLE PAYLOAD COMES BACK, AND IS THEN DISTRUSTED
   *
   * `approve` executes the stored payload verbatim, which is what makes an approval
   * mean something: the salesman cannot change the document after a supervisor has
   * seen it. Amendment has to preserve that property in the other direction — a
   * supervisor may say "one free, not five", and may NOT quietly reprice the paid
   * lines on the way past. That is a different power, nobody asked for it, and it
   * would arrive unaudited.
   *
   * So the incoming payload is compared field by field against the stored one, and
   * the ONLY difference tolerated is the quantity of a line already marked
   * `isFree`. Anything else is a rejection, not a merge.
   *
   * A free quantity set to zero removes the line outright — "reverse it" is the
   * supervisor saying no to that giveaway while still allowing the sale, and a
   * zero-quantity line has no business reaching the ERP.
   */
  async amendPayload(
    id: string,
    payload: Record<string, unknown>,
    reviewerUserId: string,
    reviewer?: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    if (reviewer && row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
    if (reviewer) this.assertReviewerMayDecide(reviewer, row);
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }
    if (row.type !== 'VOUCHER_FREE_ITEM') {
      // Only a giveaway is negotiable. A discount or a return is approved as filed.
      throw new ConflictException(
        `Only VOUCHER_FREE_ITEM requests can be amended, not ${row.type}`,
      );
    }

    const changes = diffFreeQuantities(row.payload, payload);
    if (!changes.ok) throw new BadRequestException(changes.reason);

    // Keep what the salesman actually asked for, once. A second amendment must not
    // overwrite the original with the first supervisor's version.
    if (!row.originalPayload) row.originalPayload = row.payload;

    row.payload = changes.cleaned;
    row.amendedBy = reviewerUserId;
    row.amendedAt = new Date();
    row.amendmentNote = [row.amendmentNote, changes.note].filter(Boolean).join('; ');
    await this.repo.save(row);
    return row;
  }

  async approve(
    id: string,
    reviewerUserId: string,
    reviewer?: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    // A 403, not a filtered-away 404: acting on another supervisor's request is
    // a permission problem and should read as one.
    if (reviewer && row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
    if (reviewer) this.assertReviewerMayDecide(reviewer, row);
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }

    let resultVoucher: string | null = null;
    let failureReason: string | null = null;
    try {
      if (row.type === 'CUSTOMER_CREATE') {
        // Not a voucher — the payload is a customer, and approving it is what
        // finally brings the customer into existence. The photo the salesman
        // took travels with it and becomes a real attachment here.
        const dto = row.payload as unknown as CreateCustomerDto;
        const customer = await this.customers.create(dto);
        if (dto.photoId) {
          const photo = await this.pendingPhotos.findOne({ where: { id: dto.photoId } });
          if (photo && !photo.claimedAt) {
            await this.customers.claimPhoto(photo, customer.id, row.requesterUser);
          }
        }
        // The salesman's additional shop images, staged alongside the primary,
        // become attachments too now that the customer exists.
        await this.customers.claimExtraPhotos(
          dto.extraPhotoIds,
          customer.id,
          row.requesterUser,
        );
        resultVoucher = customer.customerNumber;
      } else {
        const created = await this.vouchers.create(await this.postable(row), {
          allowOverCreditLimit: row.type === 'CREDIT_OVER_LIMIT',
        });
        resultVoucher = created.voucherNumber;
      }
    } catch (e) {
      // Conditions changed since the request (stock sold out, customer blocked…).
      // Record the failure honestly instead of half-applying.
      failureReason = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Approval ${id} execution failed: ${failureReason}`);
    }

    row.status = failureReason ? 'rejected' : 'approved';
    row.reviewerUser = reviewerUserId;
    row.decisionNote = failureReason
      ? `تعذّر التنفيذ تلقائيًا: ${failureReason}`
      : null;
    row.resultVoucher = resultVoucher;
    row.decidedAt = new Date();
    await this.repo.save(row);

    await this.notifyDecision(row);
    return row;
  }

  /**
   * The filed payload, as a document that actually leaves the building.
   *
   * `vouchers.create` defaults `isPosted` to false and the handset cannot say
   * otherwise: its request encoder omits every field equal to its default, so the
   * `isPosted = true` on CreateVoucherRequest never reaches the wire. The mobile
   * sync path has always re-stamped it on promotion — see sync.service
   * `promoteVoucher` — but this path did not, so an approved sale was filed as a
   * DRAFT. A draft moves no stock and, because the outbox enqueue is guarded by
   * `header.isPosted`, is never exported: the supervisor saw an approval, the
   * customer had the goods, and the ERP knew nothing about either.
   *
   * The store comes with it for the same reason. The app sends no `storeNumber`
   * (sync injects the rep's van store on promotion), and without one the serial is
   * keyed to the literal store `'NA'` and the lines leave no van behind.
   *
   * An approved request is a completed sale exactly like a synced one, so it is
   * promoted exactly like one. Deliberately not narrowed to VOUCHER_FREE_ITEM: a
   * discount, a price override and a return were all sitting in the same drawer.
   */
  private async postable(row: ApprovalRequest): Promise<CreateVoucherDto> {
    const dto = { ...(row.payload as unknown as CreateVoucherDto) };
    dto.isPosted = true;
    const store = await this.vanStoreFor(row, dto);
    dto.transactions = (dto.transactions ?? []).map((l) => ({
      ...l,
      storeNumber: l.storeNumber ?? l.fromStoreNumber ?? store,
    }));
    return dto;
  }

  /** A line's own store, else the requesting rep's van, else `'NA'` as sync does. */
  private async vanStoreFor(
    row: ApprovalRequest,
    dto: CreateVoucherDto,
  ): Promise<string> {
    const line = (dto.transactions ?? []).find(
      (l) => l.storeNumber || l.fromStoreNumber || l.toStoreNumber,
    );
    const onLine = line?.storeNumber ?? line?.fromStoreNumber ?? line?.toStoreNumber;
    if (onLine) return onLine;
    if (row.repId) {
      const van = await this.vouchers.resolveRepVanStore(row.repId);
      if (van) return van;
    }
    return 'NA';
  }

  async reject(
    id: string,
    reviewerUserId: string,
    reason: string,
    reviewer?: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    if (reviewer && row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
    if (reviewer) this.assertReviewerMayDecide(reviewer, row);
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }
    row.status = 'rejected';
    row.reviewerUser = reviewerUserId;
    row.decisionNote = reason;
    row.decidedAt = new Date();
    await this.repo.save(row);

    await this.notifyDecision(row);
    return row;
  }

  /** The requester cancels their own still-pending request (e.g. left the screen). */
  async cancel(id: string, requesterUserId: string): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    if (row.requesterUser !== requesterUserId) {
      throw new ConflictException('You can only cancel your own request');
    }
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }
    row.status = 'cancelled';
    row.decidedAt = new Date();
    await this.repo.save(row);
    return row;
  }

  private async notifyDecision(row: ApprovalRequest): Promise<void> {
    const label = TYPE_LABEL[row.type];
    const approved = row.status === 'approved';
    await this.notifications.notifyUser(row.requesterUser, {
      kind: 'approval.decided',
      titleAr: approved
        ? `تمت الموافقة على طلب ${label.ar}${row.resultVoucher ? ` — سند ${row.resultVoucher}` : ''}`
        : `تم رفض طلب ${label.ar}`,
      titleEn: approved
        ? `${label.en} request approved${row.resultVoucher ? ` — voucher ${row.resultVoucher}` : ''}`
        : `${label.en} request rejected`,
      bodyAr: row.decisionNote ?? undefined,
      bodyEn: row.decisionNote ?? undefined,
      refType: 'approval',
      refId: row.id,
    });
    this.events.emit('approval.decided', {
      id: row.id,
      status: row.status,
      requesterUser: row.requesterUser,
      resultVoucher: row.resultVoucher ?? null,
      decisionNote: row.decisionNote ?? null,
    });
  }

  /**
   * Checks a CREDIT_OVER_LIMIT request and freezes the figures it is about.
   *
   * The requester must hold `vouchers.credit.request` (admins and managers
   * always may), the payload must be a SALE to a known customer with a credit
   * part, and the figures are what the supervisor sees: limit, balance, this
   * sale's credit amount, and how far past the limit it goes.
   */
  private async creditContext(
    requester: User | null,
    customerNumber: string | null,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const privileged = requester?.role === 'admin' || requester?.role === 'manager';
    if (!privileged && !(requester?.permissions ?? []).includes(PERM_CREDIT_REQUEST)) {
      throw new ForbiddenException('You are not allowed to request credit over the limit.');
    }
    const p = payload as { transKind?: string; payments?: { paymentType?: string; amount?: string | number }[] };
    if (p.transKind !== 'SALE') {
      throw new BadRequestException('A credit request must be a sale.');
    }
    const creditAmount = (p.payments ?? [])
      .filter((x) => x.paymentType === 'CREDIT')
      .reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
    if (creditAmount <= 0) {
      throw new BadRequestException('A credit request must have a credit (on-account) payment.');
    }
    if (!customerNumber) throw new BadRequestException('A credit request needs a customer.');
    const customer = await this.customerRows.findOne({ where: { customerNumber } });
    if (!customer) throw new NotFoundException(`Customer ${customerNumber} not found`);

    const creditLimit = Number(customer.creditLimit) || 0;
    const balance = Number(customer.totalDebt) || 0;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      customerName: customer.nameAr || customer.customerName,
      creditLimit: round(creditLimit),
      balance: round(balance),
      creditAmount: round(creditAmount),
      available: round(Math.max(0, creditLimit - balance)),
      overBy: round(Math.max(0, balance + creditAmount - creditLimit)),
      creditHold: customer.creditHold === true,
    };
  }

  /** Shape-check the embedded CreateVoucherDto without executing it. */
  private async validateVoucherPayload(payload: Record<string, unknown>): Promise<void> {
    const dto = plainToInstance(CreateVoucherDto, payload);
    const errors = await validate(dto, { whitelist: true });
    if (errors.length > 0) {
      const detail = errors
        .map((e) => Object.values(e.constraints ?? {}).join('; '))
        .filter(Boolean)
        .join(' | ');
      throw new BadRequestException(`Invalid voucher payload: ${detail}`);
    }
  }
}

/** One line of a proposed voucher, as far as amendment cares. */
interface Txn {
  itemNumber?: string;
  itemQty?: string;
  isFree?: boolean;
  unitCode?: string;
  [k: string]: unknown;
}

/**
 * Compare a supervisor's edit against the stored request.
 *
 * Returns the cleaned payload (zero-quantity free lines dropped) and a
 * human-readable note, or the reason it was refused. Deliberately positional: the
 * transactions must arrive in the same order they were filed, because matching them
 * up by item number would silently accept a reordered or substituted cart.
 */
function diffFreeQuantities(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
):
  | { ok: true; cleaned: Record<string, unknown>; note: string }
  | { ok: false; reason: string } {
  const a = { ...stored };
  const b = { ...incoming };
  const aTxns = (a.transactions as Txn[]) ?? [];
  const bTxns = (b.transactions as Txn[]) ?? [];
  delete a.transactions;
  delete b.transactions;

  // Everything outside the lines — customer, payments, dates, totals — must match.
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    return { ok: false, reason: 'Only free-line quantities may be amended' };
  }
  if (aTxns.length !== bTxns.length) {
    return { ok: false, reason: 'Lines may not be added or removed, only re-quantified' };
  }

  const notes: string[] = [];
  const cleaned: Txn[] = [];
  for (let i = 0; i < aTxns.length; i += 1) {
    const before = aTxns[i];
    const after = bTxns[i];
    const qtyChanged = String(before.itemQty ?? '') !== String(after.itemQty ?? '');

    if (qtyChanged && !before.isFree) {
      return { ok: false, reason: 'A paid line\'s quantity may not be amended' };
    }
    // Compare every OTHER field, so a repriced free line is refused too — the
    // supervisor is agreeing to a quantity, not setting a price.
    const strippedBefore = { ...before, itemQty: null };
    const strippedAfter = { ...after, itemQty: null };
    if (JSON.stringify(strippedBefore) !== JSON.stringify(strippedAfter)) {
      return { ok: false, reason: 'Only a free line\'s quantity may be amended' };
    }

    if (qtyChanged) {
      const unit = before.unitCode ? ` ${before.unitCode}` : '';
      notes.push(`free ${before.itemNumber ?? '?'}${unit}: ${before.itemQty} -> ${after.itemQty}`);
    }
    // Zero means the supervisor reversed this giveaway. Drop it rather than post a
    // zero-quantity line to the ERP.
    if (after.isFree && Number(after.itemQty ?? 0) <= 0) continue;
    cleaned.push(after);
  }

  if (notes.length === 0) return { ok: false, reason: 'Nothing was amended' };
  return {
    ok: true,
    cleaned: { ...b, transactions: cleaned },
    note: notes.join('; '),
  };
}
