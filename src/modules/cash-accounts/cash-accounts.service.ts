import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CashAccount, CashAccountKind } from './entities/cash-account.entity';
import { AccountEntryKind, AccountTransaction } from './entities/account-transaction.entity';
import { CreateCashAccountDto } from './dto/create-cash-account.dto';
import { UpdateCashAccountDto } from './dto/update-cash-account.dto';

export interface AccountView extends CashAccount {
  balanceFils: number;
}

export interface RepBoxSummary {
  repId: string;
  sales: AccountView | null;
  receipts: AccountView | null;
  cheques: AccountView | null;
}

/** Which box kind a settlement transfer targets. */
export interface SettleTransfers {
  salesAccountId?: string;
  receiptsAccountId?: string;
  chequesAccountId?: string;
}

@Injectable()
export class CashAccountsService {
  private readonly logger = new Logger('CashAccounts');

  constructor(
    @InjectRepository(CashAccount) private readonly accounts: Repository<CashAccount>,
    @InjectRepository(AccountTransaction) private readonly txns: Repository<AccountTransaction>,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(): Promise<AccountView[]> {
    const rows = await this.ds.query(
      `SELECT a.id, a.code, a.name, a.kind,
              a.rep_id AS "repId", a.erp_account_id AS "erpAccountId",
              a.erp_account_code AS "erpAccountCode", a.is_active AS "isActive",
              a.created_at AS "createdAt", a.updated_at AS "updatedAt",
              COALESCE(SUM(t.amount_fils), 0)::bigint AS "balanceFils"
         FROM cash_accounts a
         LEFT JOIN account_transactions t ON t.account_id = a.id
        GROUP BY a.id
        ORDER BY a.kind, a.name`,
    );
    return rows.map((r: Record<string, unknown>) => ({
      ...(r as unknown as CashAccount),
      balanceFils: Number(r.balanceFils ?? 0),
    }));
  }

  async create(dto: CreateCashAccountDto): Promise<CashAccount> {
    const code = dto.code?.trim() || this.genCode(dto.kind, dto.repId ?? null);
    const dup = await this.accounts.findOne({ where: { code } });
    if (dup) throw new ConflictException(`Account code '${code}' already exists.`);
    return this.accounts.save(
      this.accounts.create({
        code,
        name: dto.name,
        kind: dto.kind,
        repId: dto.repId ?? null,
        erpAccountId: dto.erpAccountId ?? null,
        erpAccountCode: dto.erpAccountCode ?? null,
        isActive: true,
      }),
    );
  }

  async update(id: string, dto: UpdateCashAccountDto): Promise<CashAccount> {
    const acc = await this.accounts.findOne({ where: { id } });
    if (!acc) throw new NotFoundException('Account not found.');
    if (dto.name !== undefined) acc.name = dto.name;
    if (dto.erpAccountId !== undefined) acc.erpAccountId = dto.erpAccountId;
    if (dto.erpAccountCode !== undefined) acc.erpAccountCode = dto.erpAccountCode;
    if (dto.isActive !== undefined) acc.isActive = dto.isActive;
    return this.accounts.save(acc);
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const count = await this.txns.count({ where: { accountId: id } });
    if (count > 0) throw new BadRequestException('Account has transactions and cannot be deleted.');
    const res = await this.accounts.delete(id);
    if (!res.affected) throw new NotFoundException('Account not found.');
    return { deleted: true };
  }

  /** Ledger of one account, optional date range + entry kind filter. */
  async transactions(
    accountId: string,
    opts: { from?: string; to?: string; kind?: string } = {},
  ): Promise<AccountTransaction[]> {
    const from = opts.from ? new Date(opts.from) : null;
    const to = opts.to ? new Date(opts.to) : null;
    return this.ds.query(
      `SELECT id, account_id AS "accountId", entry_kind AS "entryKind",
              amount_fils::bigint AS "amountFils", label, rep_id AS "repId",
              ref_type AS "refType", ref_id AS "refId", settlement_id AS "settlementId",
              created_at AS "createdAt"
         FROM account_transactions
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at <= $3)
          AND ($4::text IS NULL OR entry_kind = $4)
        ORDER BY created_at DESC`,
      [accountId, from, to, opts.kind ?? null],
    );
  }

  /** A rep's three boxes + balances (for the EOD tab + settle dialog). */
  async repSummary(repId: string): Promise<RepBoxSummary> {
    const [sales, receipts, cheques] = await Promise.all([
      this.viewOf(await this.resolveBox(repId, 'REP_SALES', false)),
      this.viewOf(await this.resolveBox(repId, 'REP_RECEIPTS', false)),
      this.viewOf(await this.resolveBox(repId, 'REP_CHEQUES', false)),
    ]);
    return { repId, sales, receipts, cheques };
  }

  // ── Box resolution ──────────────────────────────────────────────────────

  /**
   * The account a rep's [kind] cash flows into: the rep's own active account, else the
   * shared (rep_id NULL) active account of that kind. When `autoCreate`, a per-rep box is
   * created as a last resort so boxes fill without pre-setup (admin can relink later).
   */
  async resolveBox(
    repId: string,
    kind: CashAccountKind,
    autoCreate: boolean,
    manager?: EntityManager,
  ): Promise<CashAccount | null> {
    const repo = manager ? manager.getRepository(CashAccount) : this.accounts;
    const own = await repo.findOne({ where: { repId, kind, isActive: true } });
    if (own) return own;
    // Shared box (rep_id IS NULL) — raw, aliased to the entity shape.
    const [sharedRow] = await (manager ?? this.ds).query(
      `SELECT id, code, name, kind, rep_id AS "repId", erp_account_id AS "erpAccountId",
              erp_account_code AS "erpAccountCode", is_active AS "isActive",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM cash_accounts WHERE rep_id IS NULL AND kind = $1 AND is_active = true LIMIT 1`,
      [kind],
    );
    if (sharedRow) return sharedRow as CashAccount;
    if (!autoCreate) return null;
    const repName = await this.repName(repId);
    const code = this.genCode(kind, repId);
    return repo.save(
      repo.create({
        code,
        name: `${kindLabelAr(kind)} — ${repName ?? repId.slice(0, 8)}`,
        kind,
        repId,
        isActive: true,
      }),
    );
  }

  // ── Ledger writes ───────────────────────────────────────────────────────

  /** Idempotent auto-entry (SALE/COLLECTION/CHEQUE) keyed on (refType, refId, entryKind). */
  private async postEntry(
    e: {
      accountId: string;
      entryKind: AccountEntryKind;
      amountFils: number;
      label: string;
      repId?: string | null;
      refType?: string | null;
      refId?: string | null;
      settlementId?: string | null;
    },
    manager?: EntityManager,
  ): Promise<void> {
    const runner = manager ?? this.ds;
    await runner.query(
      `INSERT INTO account_transactions
         (account_id, entry_kind, amount_fils, label, rep_id, ref_type, ref_id, settlement_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ref_type, ref_id, entry_kind)
         WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL
       DO NOTHING`,
      [
        e.accountId, e.entryKind, Math.round(e.amountFils), e.label,
        e.repId ?? null, e.refType ?? null, e.refId ?? null, e.settlementId ?? null,
      ],
    );
  }

  // ── Event-driven auto-entries ───────────────────────────────────────────

  /** A posted SALE/RETURN's CASH portion feeds the rep's sales box (sales only). */
  @OnEvent('erp.voucher.posted')
  async onVoucherPosted(payload: { voucherNumber: string }): Promise<void> {
    try {
      const [row] = await this.ds.query(
        `SELECT h.trans_kind AS "transKind",
                COALESCE(SUM(p.amount) FILTER (WHERE p.payment_type = 'CASH'), 0)::float8 AS "cashJod",
                r.id AS "repId", COALESCE(r.name_ar, r.name_en) AS "repName"
           FROM voucher_headers h
           LEFT JOIN payments p ON p.voucher_number = h.voucher_number
           LEFT JOIN users u ON u.user_number = h.user_code
           LEFT JOIN reps  r ON r.user_id = u.id
          WHERE h.voucher_number = $1
          GROUP BY h.trans_kind, r.id, r.name_ar, r.name_en`,
        [payload.voucherNumber],
      );
      if (!row?.repId) return;
      const kind = String(row.transKind);
      if (kind !== 'SALE' && kind !== 'RETURN') return; // sales box: only sales/returns
      const cashFils = Math.round(Number(row.cashJod) * 1000);
      if (cashFils <= 0) return; // credit sale / no cash → nothing enters the box
      const box = await this.resolveBox(row.repId, 'REP_SALES', true);
      if (!box) return;
      await this.postEntry({
        accountId: box.id,
        entryKind: 'SALE',
        amountFils: kind === 'RETURN' ? -cashFils : cashFils,
        label: labelFor('SALE', row.repName),
        repId: row.repId,
        refType: 'voucher',
        refId: payload.voucherNumber,
      });
    } catch (err) {
      this.logger.warn(`onVoucherPosted failed for ${payload.voucherNumber}: ${msg(err)}`);
    }
  }

  /** A confirmed collection feeds the rep's receipts (cash) or cheques box. */
  @OnEvent('erp.collection.confirmed')
  async onCollectionConfirmed(payload: { collectionId: string }): Promise<void> {
    try {
      const [row] = await this.ds.query(
        `SELECT co.rep_id AS "repId", co.method, co.amount, co.status,
                COALESCE(r.name_ar, r.name_en) AS "repName"
           FROM collections co
           LEFT JOIN reps r ON r.id = co.rep_id
          WHERE co.id = $1`,
        [payload.collectionId],
      );
      if (!row?.repId) return;
      if (!['confirmed', 'deposited'].includes(String(row.status))) return;
      const isCheque = String(row.method) === 'cheque';
      const box = await this.resolveBox(row.repId, isCheque ? 'REP_CHEQUES' : 'REP_RECEIPTS', true);
      if (!box) return;
      await this.postEntry({
        accountId: box.id,
        entryKind: isCheque ? 'CHEQUE' : 'COLLECTION',
        amountFils: Number(row.amount), // collections.amount is already fils
        label: labelFor(isCheque ? 'CHEQUE' : 'COLLECTION', row.repName),
        repId: row.repId,
        refType: 'collection',
        refId: payload.collectionId,
      });
    } catch (err) {
      this.logger.warn(`onCollectionConfirmed failed for ${payload.collectionId}: ${msg(err)}`);
    }
  }

  // ── Settlement transfers (empty the boxes) ──────────────────────────────

  /**
   * Empty a rep's boxes into the chosen destination accounts on settlement. For each
   * non-empty box with a destination, writes a SETTLEMENT_OUT (−balance) on the box and a
   * SETTLEMENT_IN (+balance) on the destination, grouped by settlementId, in one tx.
   * Returns the transferred amounts per box.
   */
  async settleTransfers(
    repId: string,
    settlementId: string,
    transfers: SettleTransfers,
  ): Promise<{ salesFils: number; receiptsFils: number; chequesFils: number }> {
    const plan: Array<[CashAccountKind, string | undefined]> = [
      ['REP_SALES', transfers.salesAccountId],
      ['REP_RECEIPTS', transfers.receiptsAccountId],
      ['REP_CHEQUES', transfers.chequesAccountId],
    ];
    const moved = { salesFils: 0, receiptsFils: 0, chequesFils: 0 };
    const repName = await this.repName(repId);

    await this.ds.transaction(async (m) => {
      for (const [kind, destId] of plan) {
        const box = await this.resolveBox(repId, kind, false, m);
        if (!box) continue;
        const balance = await this.balanceOf(box.id, m);
        if (balance === 0 || !destId) continue;
        const dest = await m.getRepository(CashAccount).findOne({ where: { id: destId } });
        if (!dest) throw new NotFoundException(`Destination account ${destId} not found.`);
        await this.postEntry(
          { accountId: box.id, entryKind: 'SETTLEMENT_OUT', amountFils: -balance,
            label: labelFor('SETTLEMENT_OUT', repName), repId, settlementId },
          m,
        );
        await this.postEntry(
          { accountId: dest.id, entryKind: 'SETTLEMENT_IN', amountFils: balance,
            label: labelFor('SETTLEMENT_IN', repName), repId, settlementId },
          m,
        );
        if (kind === 'REP_SALES') moved.salesFils = balance;
        else if (kind === 'REP_RECEIPTS') moved.receiptsFils = balance;
        else moved.chequesFils = balance;
      }
    });
    return moved;
  }

  /**
   * Reconstruct the ERP GL journal for a completed settlement from its SETTLEMENT_IN/OUT
   * rows: DR each destination that received cash, CR each rep box that was emptied
   * (both are cash/asset accounts, so a transfer is DR dest / CR box). Amounts are JOD
   * major (the ERP journal endpoint re-scales to thousandths). Returns null when nothing
   * was settled OR any involved account isn't ERP-linked — in which case the caller keeps
   * the legacy cash-settlement push instead of a partial (unbalanced) journal.
   */
  async buildSettlementJournal(
    settlementId: string,
  ): Promise<{ externalId: string; description: string; date?: string; lines: Array<{ accountCode: string; debit: number; credit: number; description: string }> } | null> {
    const rows: Array<{ entryKind: string; amountFils: string; erpAccountCode: string | null; accountName: string }> =
      await this.ds.query(
        `SELECT t.entry_kind AS "entryKind", ABS(t.amount_fils)::bigint AS "amountFils",
                a.erp_account_code AS "erpAccountCode", a.name AS "accountName"
           FROM account_transactions t
           JOIN cash_accounts a ON a.id = t.account_id
          WHERE t.settlement_id = $1
            AND t.entry_kind IN ('SETTLEMENT_OUT', 'SETTLEMENT_IN')
          ORDER BY t.entry_kind DESC`, // IN before OUT (debits first, tidy journal)
        [settlementId],
      );
    if (!rows.length) return null; // nothing moved (empty boxes / no destinations)
    if (rows.some((r) => !r.erpAccountCode)) {
      this.logger.warn(`settlement ${settlementId} has unlinked cash accounts — GL journal skipped`);
      return null;
    }
    const lines = rows.map((r) => {
      const major = Number(r.amountFils) / 1000; // fils → JOD major
      const isIn = r.entryKind === 'SETTLEMENT_IN';
      return {
        accountCode: r.erpAccountCode as string,
        debit: isIn ? major : 0,
        credit: isIn ? 0 : major,
        description: r.accountName,
      };
    });
    return {
      externalId: `settlement-${settlementId}`,
      description: `تسوية صناديق المندوب — ${settlementId}`,
      lines,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async balanceOf(accountId: string, manager?: EntityManager): Promise<number> {
    const [r] = await (manager ?? this.ds).query(
      `SELECT COALESCE(SUM(amount_fils), 0)::bigint AS bal FROM account_transactions WHERE account_id = $1`,
      [accountId],
    );
    return Number(r?.bal ?? 0);
  }

  private async viewOf(acc: CashAccount | null): Promise<AccountView | null> {
    if (!acc) return null;
    return { ...acc, balanceFils: await this.balanceOf(acc.id) };
  }

  private async repName(repId: string): Promise<string | null> {
    const [r] = await this.ds.query(
      `SELECT COALESCE(name_ar, name_en) AS name FROM reps WHERE id = $1`,
      [repId],
    );
    return r?.name ?? null;
  }

  private genCode(kind: CashAccountKind, repId: string | null): string {
    const suffix = repId ? repId.slice(0, 8) : 'SHARED';
    return `${kind}-${suffix}-${Date.now().toString(36)}`;
  }
}

const KIND_LABEL_AR: Record<CashAccountKind, string> = {
  REP_SALES: 'مبيعات المندوب',
  REP_RECEIPTS: 'تحصيلات المندوب',
  REP_CHEQUES: 'شيكات المندوب',
  COMPANY: 'حساب الشركة',
};
function kindLabelAr(kind: CashAccountKind): string {
  return KIND_LABEL_AR[kind];
}

function labelFor(entry: AccountEntryKind, repName: string | null): string {
  const name = repName ?? '—';
  switch (entry) {
    case 'SALE':
      return `مندوب المبيعات ${name}`;
    case 'COLLECTION':
      return `تحصيل — ${name}`;
    case 'CHEQUE':
      return `شيك — ${name}`;
    case 'SETTLEMENT_OUT':
      return `تسوية (صرف) — ${name}`;
    case 'SETTLEMENT_IN':
      return `تسوية (توريد) — ${name}`;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
