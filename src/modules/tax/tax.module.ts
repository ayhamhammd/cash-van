import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreditNote } from './entities/credit-note.entity';
import { CreditNoteLine } from './entities/credit-note-line.entity';
import { TaxLedgerEntry } from './entities/tax-ledger-entry.entity';
import { JoFotaraSubmissionLog } from './entities/jofotara-submission-log.entity';
import { Invoice } from '../invoices/entities/invoice.entity';
import { InvoiceLine } from '../invoices/entities/invoice-line.entity';
import { Customer } from '../customers/entities/customer.entity';

import { JoFotaraBuilderService } from './jofotara-builder.service';
import { InvoiceValidatorService } from './invoice-validator.service';
import { JoFotaraApiService } from './jofotara-api.service';
import { TaxLedgerService } from './tax-ledger.service';
import { JoFotaraSubmissionService } from './jofotara-submission.service';
import { CreditNotesService } from './credit-notes.service';

import { CreditNotesController } from './credit-notes.controller';
import { JoFotaraController } from './jofotara.controller';
import { TaxReportController } from './tax-report.controller';

import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CreditNote,
      CreditNoteLine,
      TaxLedgerEntry,
      JoFotaraSubmissionLog,
      Invoice,
      InvoiceLine,
      Customer,
    ]),
    SettingsModule,
  ],
  controllers: [CreditNotesController, JoFotaraController, TaxReportController],
  providers: [
    JoFotaraBuilderService,
    InvoiceValidatorService,
    JoFotaraApiService,
    TaxLedgerService,
    JoFotaraSubmissionService,
    CreditNotesService,
  ],
  exports: [TaxLedgerService, JoFotaraSubmissionService],
})
export class TaxModule {}
