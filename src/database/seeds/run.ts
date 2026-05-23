import 'reflect-metadata';
import * as bcrypt from 'bcrypt';

import dataSource from '../data-source';
import { User } from '../../modules/users/entities/user.entity';
import { TransactionKind } from '../../modules/vouchers/entities/transaction-kind.entity';
import { Warehouse } from '../../modules/warehouses/entities/warehouse.entity';

async function seed(): Promise<void> {
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    // ---- transaction kinds --------------------------------------------------
    const kindsRepo = queryRunner.manager.getRepository(TransactionKind);
    const kinds: Array<Partial<TransactionKind>> = [
      { transKind: 'SALE',         transName: 'Sales invoice',          sign: -1 },
      { transKind: 'PURCHASE',     transName: 'Purchase invoice',       sign:  1 },
      { transKind: 'RETURN_IN',    transName: 'Customer return (in)',   sign:  1 },
      { transKind: 'RETURN_OUT',   transName: 'Vendor return (out)',    sign: -1 },
      { transKind: 'TRANSFER_IN',  transName: 'Stock transfer in',      sign:  1 },
      { transKind: 'TRANSFER_OUT', transName: 'Stock transfer out',     sign: -1 },
      { transKind: 'ADJUSTMENT',   transName: 'Manual adjustment',      sign:  0 },
      { transKind: 'PAYMENT_IN',   transName: 'Payment received',       sign:  0 },
      { transKind: 'PAYMENT_OUT',  transName: 'Payment made',           sign:  0 },
    ];
    for (const k of kinds) {
      const exists = await kindsRepo.exist({ where: { transKind: k.transKind } });
      if (!exists) {
        await kindsRepo.save(kindsRepo.create(k));
      }
    }

    // ---- default admin ------------------------------------------------------
    const usersRepo = queryRunner.manager.getRepository(User);
    const adminExists = await usersRepo.exist({ where: { userNumber: 'admin' } });
    if (!adminExists) {
      const passwordHash = await bcrypt.hash('admin1234', 12);
      await usersRepo.save(
        usersRepo.create({
          userNumber: 'admin',
          name: 'Default Admin',
          nameAr: 'المدير',
          nameEn: 'Default Admin',
          role: 'admin',
          passwordHash,
          userType: 'ADMIN',
          isActive: true,
          canMakeVoucher: true,
          canEditVoucher: true,
          canAddCustomer: true,
          canEditCustomerCredit: true,
          canAddItems: true,
          canEditExpiry: true,
        }),
      );
    }

    // ---- default warehouse --------------------------------------------------
    const whRepo = queryRunner.manager.getRepository(Warehouse);
    const whExists = await whRepo.exist({ where: { whNumber: 'MAIN' } });
    if (!whExists) {
      await whRepo.save(
        whRepo.create({
          whNumber: 'MAIN',
          whName: 'Main Warehouse',
        }),
      );
    }

    await queryRunner.commitTransaction();
    // eslint-disable-next-line no-console
    console.log('Seed completed.');
  } catch (err) {
    await queryRunner.rollbackTransaction();
    // eslint-disable-next-line no-console
    console.error('Seed failed', err);
    process.exitCode = 1;
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

seed();
