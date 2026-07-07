import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CashAccount } from './entities/cash-account.entity';
import { AccountTransaction } from './entities/account-transaction.entity';
import { CashAccountsService } from './cash-accounts.service';
import { CashAccountsController } from './cash-accounts.controller';

/**
 * EOD rep cash accounts (boxes) + ledger. Feeds boxes from posted cash sales +
 * confirmed collections (event listeners) and empties them on settlement.
 * See docs/SPEC-eod-rep-cash-accounts.md.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CashAccount, AccountTransaction])],
  controllers: [CashAccountsController],
  providers: [CashAccountsService],
  exports: [CashAccountsService],
})
export class CashAccountsModule {}
