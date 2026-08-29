import {
  BadRequestException,
  ConflictException,
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
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const TYPE_LABEL: Record<ApprovalType, { ar: string; en: string }> = {
  RETURN_VOUCHER: { ar: 'مرتجع', en: 'Return' },
  VOUCHER_DISCOUNT: { ar: 'خصم', en: 'Discount' },
  PRICE_OVERRIDE: { ar: 'تغيير سعر', en: 'Price change' },
  CUSTOMER_CREATE: { ar: 'إضافة عميل', en: 'New customer' },
};

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

    const row = await this.repo.save(
      this.repo.create({
        type: dto.type,
        requesterUser: requesterUserId,
        repId: rep?.id ?? null,
        customerNumber:
          dto.customerNumber ??
          ((dto.payload as { customerNumber?: string }).customerNumber || null),
        payload: dto.payload,
        note: dto.note ?? null,
      }),
    );

    const repName = rep?.nameAr ?? requester?.name ?? requester?.userNumber ?? '—';
    const label = TYPE_LABEL[dto.type];
    await this.notifications.notifyManagers(
      {
        kind: 'approval.requested',
        titleAr: `طلب ${label.ar} جديد من ${repName}`,
        titleEn: `New ${label.en.toLowerCase()} request from ${repName}`,
        bodyAr: dto.note ?? undefined,
        bodyEn: dto.note ?? undefined,
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
    return { items, total };
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
   * Approve → execute the stored voucher payload verbatim. Runs as the
   * reviewing manager (their CLS context), so the salesman-permission gate in
   * VouchersService passes; attribution stays with the rep via payload.userCode.
   */
  async approve(
    id: string,
    reviewerUserId: string,
    reviewer?: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    // A 403, not a filtered-away 404: acting on another supervisor's request is
    // a permission problem and should read as one.
    if (reviewer && row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
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
        const created = await this.vouchers.create(
          row.payload as unknown as CreateVoucherDto,
        );
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

  async reject(
    id: string,
    reviewerUserId: string,
    reason: string,
    reviewer?: AuthenticatedUser,
  ): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    if (reviewer && row.repId) await this.repScope.assertCanSeeRep(reviewer, row.repId);
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
