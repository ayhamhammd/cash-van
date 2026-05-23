import {
  Body,
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

import { CreditNotesService } from './credit-notes.service';
import { JoFotaraSubmissionService } from './jofotara-submission.service';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('credit-notes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'credit-notes', version: '1' })
export class CreditNotesController {
  constructor(
    private readonly creditNotes: CreditNotesService,
    private readonly submission: JoFotaraSubmissionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List credit notes', description: 'List all credit notes (returns).' })
  @ApiOkResponse({ description: 'Credit note list' })
  list() {
    return this.creditNotes.list();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get credit note',
    description: 'Fetch a single credit note with its lines.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Credit note id' })
  @ApiOkResponse({ description: 'The credit note with lines' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.creditNotes.findOne(id);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Create credit note',
    description:
      'Create a credit note (return) against an invoice and auto-submit it to ISTD JoFotara. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Credit note created and submitted' })
  create(@Body() dto: CreateCreditNoteDto) {
    return this.creditNotes.create(dto);
  }
}
