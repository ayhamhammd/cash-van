import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Cheque } from './entities/cheque.entity';
import { ListChequesQuery } from './dto/query.dto';
import {
  ReconcileChequeDto,
  UpdateChequeDetailsDto,
} from './dto/collection-actions.dto';
import { ErpHttpClient } from '../erp-sync/erp-http.client';
import { ErpOutboxService } from '../erp-sync/erp-outbox.service';
import { UserContextService } from '../../common/context/user-context.service';
import { filsToJod } from '../../common/utils/currency.util';

/** What became of the ERP receipt after a cheque's details were completed. */
export interface ChequeErpOutcome {
  action:
    | 'queued'
    | 'already_queued'
    | 'already_posted'
    | 'retried'
    /** The ERP already had the receipt; its missing Financial Paper was registered. */
    | 'paper_attached';
  status: 'pending' | 'posted' | 'failed' | 'dead_letter';
  erpRef?: string;
  /** Why it is still not in the ERP, or what to do instead. */
  message?: string;
}

@Injectable()
export class ChequesService {
  constructor(
    @InjectRepository(Cheque) private readonly cheques: Repository<Cheque>,
    private readonly userCtx: UserContextService,
    private readonly outbox: ErpOutboxService,
    private readonly erp: ErpHttpClient,
  ) {}

  async list(q: ListChequesQuery): Promise<Cheque[]> {
    const qb = this.cheques.createQueryBuilder('ch').orderBy('ch.due_date', 'ASC');
    if (q.status) qb.andWhere('ch.status = :s', { s: q.status });
    if (q.dueFrom) qb.andWhere('ch.due_date >= :df', { df: q.dueFrom });
    if (q.dueTo) qb.andWhere('ch.due_date <= :dt', { dt: q.dueTo });
    return qb.getMany();
  }

  /** Cheques needing manager review: words mismatch and not yet reconciled. */
  async reconcileQueue(): Promise<Cheque[]> {
    return this.cheques
      .createQueryBuilder('ch')
      .where('ch.words_match = FALSE')
      .andWhere('ch.reconciled_at IS NULL')
      .orderBy('ch.created_at', 'ASC')
      .getMany();
  }

  async reconcile(id: string, dto: ReconcileChequeDto): Promise<Cheque> {
    const ch = await this.getOne(id);
    ch.amount = dto.amount;
    if (dto.amountWords !== undefined) ch.amountWords = dto.amountWords;
    if (dto.bankName !== undefined) ch.bankName = dto.bankName;
    if (dto.chequeNumber !== undefined) ch.chequeNumber = dto.chequeNumber;
    if (dto.dueDate !== undefined) ch.dueDate = dto.dueDate;
    ch.wordsMatch = true; // manager confirmed the correct value
    ch.reconciledAt = new Date();
    ch.reconciledBy = this.userCtx.getUserId();
    return this.cheques.save(ch);
  }

  /**
   * Supply what the handset never captured, then push the receipt again.
   *
   * The ERP refuses a CHECK receipt that cannot name its cheque (number AND due
   * date), and the handsets send no due date at all. The collection is already
   * recorded here and the money is real; what is missing is two fields the
   * office can read off the paper cheque. Writing them is only half the job —
   * the receipt is sitting in the outbox marked failed, and nothing retries a
   * dead-lettered row on its own.
   *
   * The outcome is reported rather than assumed, because "saved" and "the ERP
   * now has it" are different facts and the office needs the second one. A
   * receipt the ERP already posted is NOT re-pushed: it is idempotent on
   * externalId, so a retry would return the existing voucher and change
   * nothing. Those need their Financial Paper attached on the ERP side.
   */
  async updateDetails(
    id: string,
    dto: UpdateChequeDetailsDto,
  ): Promise<{ cheque: Cheque; erp: ChequeErpOutcome }> {
    if (
      dto.dueDate === undefined &&
      dto.chequeNumber === undefined &&
      dto.bankName === undefined
    ) {
      throw new BadRequestException('Supply at least one cheque detail to update.');
    }
    const ch = await this.getOne(id);
    if (dto.dueDate !== undefined) ch.dueDate = dto.dueDate;
    if (dto.chequeNumber !== undefined) ch.chequeNumber = dto.chequeNumber;
    if (dto.bankName !== undefined) ch.bankName = dto.bankName;
    const saved = await this.cheques.save(ch);
    return { cheque: saved, erp: await this.repushReceipt(saved) };
  }

  /**
   * Re-push the collection this cheque belongs to, and say what happened.
   *
   * Only a failed or dead-lettered receipt is retried. A pending one is already
   * on its way and re-queueing it would just reset its backoff; a posted one is
   * in the ERP and cannot be changed by pushing again.
   */
  private async repushReceipt(ch: Cheque): Promise<ChequeErpOutcome> {
    const row = await this.outbox.findFor('PAYMENT', ch.collectionId);
    if (!row) {
      await this.outbox.enqueue('PAYMENT', ch.collectionId);
      return { action: 'queued', status: 'pending' };
    }
    if (row.status === 'posted') return this.attachPaper(ch, row.resultRef ?? undefined);
    if (row.status === 'pending') {
      return { action: 'already_queued', status: 'pending' };
    }
    // failed | dead_letter — push it now so the office sees the result here,
    // rather than waiting a drain interval to find out it failed again.
    const after = await this.outbox.retry(row.id);
    return {
      action: 'retried',
      status: after.status,
      erpRef: after.resultRef ?? undefined,
      message: after.status === 'posted' ? undefined : (after.error ?? undefined),
    };
  }

  /**
   * Register the paper for a receipt the ERP already posted.
   *
   * These are the cheques that went out before either side could name them: the
   * ERP holds a posted voucher with the money correctly booked and no paper
   * behind it, so the cheque cannot be chased, cleared or bounced and the bank
   * run cannot list it. Re-pushing the receipt does nothing — it is idempotent
   * on externalId — so the paper is attached directly instead.
   *
   * The ERP side deliberately posts NO journal for this: the original voucher
   * already debited the cheque box and credited the customer, and posting the
   * paper's own entry on top would credit that customer twice for one cheque.
   *
   * Needs the due date, which is the whole reason the office is on this screen.
   * Refusing early keeps the ERP's error out of it: "dueDate is required" from
   * a repair endpoint reads like a bug in the repair.
   */
  private async attachPaper(
    ch: Cheque,
    erpRef: string | undefined,
  ): Promise<ChequeErpOutcome> {
    const due = ch.dueDate?.toString().slice(0, 10);
    const number = ch.chequeNumber?.trim();
    if (!number || !due) {
      return {
        action: 'already_posted',
        status: 'posted',
        erpRef,
        message:
          'The ERP already posted this receipt. Supply the cheque number AND due date ' +
          'to register its Financial Paper.',
      };
    }
    try {
      const res = await this.erp.post(
        'receipts/attach-paper',
        {
          externalId: ch.collectionId,
          checkNumber: number,
          checkDueDate: due,
          ...(ch.bankName?.trim() ? { checkBankName: ch.bankName.trim() } : {}),
        },
        `${ch.collectionId}-PAPER`,
      );
      if (!res.ok) {
        return {
          action: 'already_posted',
          status: 'posted',
          erpRef,
          message: `The receipt is posted, but its Financial Paper could not be registered: ${res.error}`,
        };
      }
      return {
        action: 'paper_attached',
        status: 'posted',
        erpRef,
        message: 'The ERP already held this receipt; its Financial Paper is now registered.',
      };
    } catch (e) {
      // A repair that cannot reach the ERP is not a failed edit — the cheque
      // details are saved either way, and the office can run this again.
      return {
        action: 'already_posted',
        status: 'posted',
        erpRef,
        message: `The receipt is posted, but the ERP could not be reached to register its paper: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }

  async markCleared(id: string): Promise<Cheque> {
    const ch = await this.getOne(id);
    ch.status = 'cleared';
    return this.cheques.save(ch);
  }

  async markBounced(id: string): Promise<Cheque> {
    const ch = await this.getOne(id);
    ch.status = 'bounced';
    return this.cheques.save(ch);
  }

  /** Bank clearing list as CSV: bank, cheque#, payee, amount(JOD), due_date. */
  async exportBankCsv(): Promise<string> {
    const rows = await this.cheques.find({ where: { status: 'pending' }, order: { dueDate: 'ASC' } });
    const header = 'bank_name,cheque_number,payee,amount_jod,due_date';
    const lines = rows.map((c) =>
      [
        csv(c.bankName),
        csv(c.chequeNumber),
        csv(c.payee),
        filsToJod(c.amount),
        csv(c.dueDate),
      ].join(','),
    );
    return [header, ...lines].join('\n');
  }

  private async getOne(id: string): Promise<Cheque> {
    const ch = await this.cheques.findOne({ where: { id } });
    if (!ch) throw new NotFoundException(`Cheque ${id} not found`);
    return ch;
  }
}

function csv(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
