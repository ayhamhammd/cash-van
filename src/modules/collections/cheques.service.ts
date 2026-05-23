import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Cheque } from './entities/cheque.entity';
import { ListChequesQuery } from './dto/query.dto';
import { ReconcileChequeDto } from './dto/collection-actions.dto';
import { UserContextService } from '../../common/context/user-context.service';
import { filsToJod } from '../../common/utils/currency.util';

@Injectable()
export class ChequesService {
  constructor(
    @InjectRepository(Cheque) private readonly cheques: Repository<Cheque>,
    private readonly userCtx: UserContextService,
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
