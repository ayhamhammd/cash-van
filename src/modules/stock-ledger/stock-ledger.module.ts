import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StockBalance } from './entities/stock-balance.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockLedgerController } from './stock-ledger.controller';
import { StockLedgerService } from './stock-ledger.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockMovement, StockBalance])],
  controllers: [StockLedgerController],
  providers: [StockLedgerService],
  exports: [StockLedgerService],
})
export class StockLedgerModule {}
