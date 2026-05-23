import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import { ChequesService } from './cheques.service';
import { ListChequesQuery } from './dto/query.dto';
import { ReconcileChequeDto } from './dto/collection-actions.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('cheques')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'cheques', version: '1' })
export class ChequesController {
  constructor(private readonly cheques: ChequesService) {}

  @Get()
  @ApiOperation({
    summary: 'List cheques',
    description: 'List cheques, optionally filtered by status and/or due-date range.',
  })
  @ApiOkResponse({ description: 'Cheque list' })
  list(@Query() query: ListChequesQuery) {
    return this.cheques.list(query);
  }

  @Get('reconcile/queue')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Reconciliation queue',
    description:
      'Cheques needing reconciliation (numeric/words amount mismatch, still unreconciled). Admin/manager only.',
  })
  @ApiOkResponse({ description: 'Cheques pending reconciliation' })
  queue() {
    return this.cheques.reconcileQueue();
  }

  @Get('export/bank')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Export bank clearing CSV',
    description: 'Bank clearing list (CSV) for pending cheques. Admin/manager only.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'CSV file download' })
  async exportBank(@Res() res: Response) {
    const csv = await this.cheques.exportBankCsv();
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cheque-clearing.csv"',
    });
    res.send(csv);
  }

  @Post(':id/reconcile')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Reconcile cheque',
    description:
      'Confirm the correct cheque values; clears the amount-mismatch block. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Cheque id' })
  @ApiCreatedResponse({ description: 'Reconciled cheque' })
  reconcile(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReconcileChequeDto) {
    return this.cheques.reconcile(id, dto);
  }

  @Post(':id/mark-cleared')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Mark cheque cleared', description: 'Mark a cheque as cleared. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Cheque id' })
  @ApiCreatedResponse({ description: 'Cheque marked cleared' })
  markCleared(@Param('id', ParseUUIDPipe) id: string) {
    return this.cheques.markCleared(id);
  }

  @Post(':id/mark-bounced')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Mark cheque bounced', description: 'Mark a cheque as bounced. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Cheque id' })
  @ApiCreatedResponse({ description: 'Cheque marked bounced' })
  markBounced(@Param('id', ParseUUIDPipe) id: string) {
    return this.cheques.markBounced(id);
  }
}
