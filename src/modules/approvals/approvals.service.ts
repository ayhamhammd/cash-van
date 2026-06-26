import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

const TYPE_LABEL: Record<ApprovalType, { ar: string; en: string }> = {
  RETURN_VOUCHER: { ar: 'مرتجع', en: 'Return' },
  VOUCHER_DISCOUNT: { ar: 'خصم', en: 'Discount' },
  PRICE_OVERRIDE: { ar: 'تغيير سعر', en: 'Price change' },
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
    private readonly vouchers: VouchersService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

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

  async list(q: ListApprovalsQueryDto): Promise<{ items: ApprovalRequest[]; total: number }> {
    const [items, total] = await this.repo.findAndCount({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
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
  async approve(id: string, reviewerUserId: string): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
    if (row.status !== 'pending') {
      throw new ConflictException(`Request is already ${row.status}`);
    }

    let resultVoucher: string | null = null;
    let failureReason: string | null = null;
    try {
      const created = await this.vouchers.create(
        row.payload as unknown as CreateVoucherDto,
      );
      resultVoucher = created.voucherNumber;
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

  async reject(id: string, reviewerUserId: string, reason: string): Promise<ApprovalRequest> {
    const row = await this.findOneOrThrow(id);
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
