import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import type {
  DeepPartial,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import dataSource from '../data-source';
import { User } from '../../modules/users/entities/user.entity';
import { TransactionKind } from '../../modules/vouchers/entities/transaction-kind.entity';

/**
 * Minimal production seed: the default **admin login** plus the **transaction
 * kinds** the vouchers module reads at runtime. NO demo business data — a fresh
 * deploy comes up empty and is filled from the ERP sync / the dashboard.
 * Idempotent: every row is upserted on a natural key, so re-running is safe.
 */
async function seed(): Promise<void> {
  await dataSource.initialize();
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  /**
   * Find-or-create on a natural key. Looks at soft-deleted rows too so a row
   * that still occupies its UNIQUE key is recovered instead of colliding on a
   * plain insert — keeps re-seeding idempotent instead of crashing the deploy.
   */
  async function upsert<T extends ObjectLiteral>(
    repo: Repository<T>,
    where: FindOptionsWhere<NoInfer<T>> | FindOptionsWhere<NoInfer<T>>[],
    data: DeepPartial<NoInfer<T>>,
  ): Promise<T> {
    const found = await repo.findOne({ where, withDeleted: true });
    if (found) {
      if ((found as { deletedAt?: Date | null }).deletedAt) {
        await repo.recover(found);
      }
      return found;
    }
    return repo.save(repo.create(data));
  }

  try {
    const m = qr.manager;

    // ── transaction kinds (system reference — read by the vouchers module) ─
    const kindsRepo = m.getRepository(TransactionKind);
    const kinds: Array<Partial<TransactionKind>> = [
      { transKind: 'SALE', transName: 'بيع', sign: -1 }, // van out
      { transKind: 'RETURN', transName: 'مرتجع', sign: 1 }, // van in
      { transKind: 'ORDER', transName: 'طلبية', sign: 0 }, // reserve until fulfilled
      { transKind: 'TRANSFER_IN', transName: 'تحميل المركبة', sign: 1 }, // van in
      { transKind: 'TRANSFER_OUT', transName: 'تنزيل المركبة', sign: -1 }, // van out
      { transKind: 'TRANSFER', transName: 'تحويل بين المخازن', sign: 0 }, // stock → stock (uses from/to store)
      { transKind: 'IN', transName: 'إدخال للمخزن', sign: 1 }, // stock in (to_store)
      { transKind: 'OUT', transName: 'إخراج من المخزن', sign: -1 }, // stock out (from_store)
      { transKind: 'PURCHASE', transName: 'شراء', sign: 1 }, // warehouse in
      { transKind: 'ADJUSTMENT', transName: 'تسوية', sign: 0 },
      { transKind: 'PAYMENT_IN', transName: 'سند قبض', sign: 0 },
      { transKind: 'PAYMENT_OUT', transName: 'سند صرف', sign: 0 },
    ];
    for (const k of kinds) {
      await upsert(kindsRepo, { transKind: k.transKind }, k);
    }

    // ── admin user (the only login) ────────────────────────────────────────
    const usersRepo = m.getRepository(User);
    const adminHash = await bcrypt.hash('admin1234', 12);
    await upsert(
      usersRepo,
      { userNumber: 'admin' },
      {
        userNumber: 'admin',
        name: 'Default Admin',
        nameAr: 'المدير',
        nameEn: 'Default Admin',
        role: 'admin',
        passwordHash: adminHash,
        userType: 'ADMIN',
        isActive: true,
        canMakeVoucher: true,
        canEditVoucher: true,
        canAddCustomer: true,
        canEditCustomerCredit: true,
        canAddItems: true,
        canEditExpiry: true,
      },
    );

    await qr.commitTransaction();
    // eslint-disable-next-line no-console
    console.log('Seed completed: admin login + transaction kinds (no demo data).');
  } catch (err) {
    await qr.rollbackTransaction();
    // eslint-disable-next-line no-console
    console.error('Seed failed', err);
    process.exitCode = 1;
  } finally {
    await qr.release();
    await dataSource.destroy();
  }
}

seed();
