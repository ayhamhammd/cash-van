import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { JoFotaraSubmissionService } from './jofotara-submission.service';
import { CreditNotesService } from './credit-notes.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('jofotara')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ version: '1' })
export class JoFotaraController {
  constructor(
    private readonly submission: JoFotaraSubmissionService,
    private readonly creditNotes: CreditNotesService,
  ) {}

  @Post('jofotara/invoices/:id/submit')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Submit invoice to ISTD',
    description: 'Submit (or retry) an invoice to ISTD JoFotara now, synchronously. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiCreatedResponse({ description: 'Submission result (status, QR, registration or error)' })
  submitInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.submission.submitInvoice(id);
  }

  @Post('jofotara/credit-notes/:id/submit')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Submit credit note to ISTD',
    description: 'Submit (or retry) a credit note to ISTD JoFotara now, synchronously. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Credit note id' })
  @ApiCreatedResponse({ description: 'Submission result (status, QR, registration or error)' })
  submitCreditNote(@Param('id', ParseUUIDPipe) id: string) {
    return this.submission.submitCreditNote(id);
  }

  @Get('jofotara/submissions/:documentId/log')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'ISTD submission log',
    description: 'ISTD submission attempt log for a document (invoice or credit note). Admin/manager only.',
  })
  @ApiParam({ name: 'documentId', format: 'uuid', description: 'Invoice or credit note id' })
  @ApiOkResponse({ description: 'Ordered submission attempts' })
  log(@Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.submission.submissionLog(documentId);
  }

  // Returnable view + per-invoice credit notes (live under /invoices for the UI).
  @Get('invoices/:id/returnable')
  @ApiOperation({
    summary: 'Returnable quantities',
    description: 'Remaining returnable quantity per line for an invoice (original qty minus already returned).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiOkResponse({ description: 'Per-line returnable quantities' })
  returnable(@Param('id', ParseUUIDPipe) id: string) {
    return this.creditNotes.returnable(id);
  }

  @Get('invoices/:id/credit-notes')
  @ApiOperation({
    summary: 'Credit notes for invoice',
    description: 'All credit notes raised against an invoice.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Invoice id' })
  @ApiOkResponse({ description: 'Credit notes for the invoice' })
  forInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.creditNotes.forInvoice(id);
  }
}
