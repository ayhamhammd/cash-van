import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { ListCollectionsQuery } from './dto/query.dto';
import { BatchDepositDto } from './dto/collection-actions.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('collections')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'collections', version: '1' })
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List collections',
    description: 'List cash/cheque collections with optional filters.',
  })
  @ApiOkResponse({ description: 'Collection list' })
  list(@Query() query: ListCollectionsQuery) {
    return this.collections.list(query);
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Daily collection summary',
    description: 'Daily totals: collected / cash / cheque / pending / overdue.',
  })
  @ApiQuery({ name: 'date', required: false, description: 'Day to summarize (YYYY-MM-DD); defaults to today', example: '2026-05-23' })
  @ApiOkResponse({ description: 'Daily collection totals' })
  summary(@Query('date') date?: string) {
    return this.collections.summary(date);
  }

  @Get('aging')
  @ApiOperation({
    summary: 'Cheque aging buckets',
    description: 'Uncleared-cheque aging buckets (0-7 / 8-30 / 31-60 / 60+ days).',
  })
  @ApiOkResponse({ description: 'Aging buckets' })
  aging() {
    return this.collections.aging();
  }

  @Post()
  @ApiOperation({
    summary: 'Record collection',
    description: 'Record a cash or cheque collection against a customer/invoice.',
  })
  @ApiCreatedResponse({ description: 'Collection recorded' })
  create(@Body() dto: CreateCollectionDto) {
    return this.collections.create(dto);
  }

  @Post('batch-deposit')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Batch deposit',
    description: 'Mark multiple confirmed collections as deposited. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Collections marked deposited' })
  batchDeposit(@Body() dto: BatchDepositDto) {
    return this.collections.batchDeposit(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get collection',
    description: 'Fetch a single collection (including its cheque, if any).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Collection id' })
  @ApiOkResponse({ description: 'The collection' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.collections.findOne(id);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Edit collection',
    description:
      'Edit a pending collection (amount, method, note, date, invoice link, cheque). ' +
      'Blocked once confirmed — ERP receipts are immutable. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Collection id' })
  @ApiOkResponse({ description: 'The updated collection' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCollectionDto) {
    return this.collections.update(id, dto);
  }

  @Post(':id/confirm')
  @ApiOperation({
    summary: 'Confirm collection',
    description:
      'Confirm a collection. Blocked if it has an unreconciled cheque amount mismatch.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Collection id' })
  @ApiCreatedResponse({ description: 'Confirmed collection' })
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.collections.confirm(id);
  }
}
