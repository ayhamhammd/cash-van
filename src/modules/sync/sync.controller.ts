import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SyncService } from './sync.service';
import {
  ListInboxQueryDto,
  SyncCollectionDto,
  SyncVoucherDto,
  SyncVoucherResultDto,
  UpdateInboxPayloadDto,
} from './dto/sync.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('vouchers')
  @ApiOperation({
    summary: 'Stage & post a voucher from the mobile app',
    description:
      'The app posts here instead of /vouchers. The server assigns the authoritative voucher number (returned immediately) and promotes the row into the main tables. Pass clientRef for idempotent retries.',
  })
  @ApiCreatedResponse({ type: SyncVoucherResultDto })
  ingestVoucher(@Body() dto: SyncVoucherDto) {
    return this.sync.ingestVoucher(dto);
  }

  @Post('collections')
  @ApiOperation({
    summary: 'Stage & post a collection from the mobile app',
    description: 'Same staging flow for cash/cheque collections. Pass clientRef for idempotency.',
  })
  @ApiCreatedResponse({ description: '{ id, status, error? }' })
  ingestCollection(@Body() dto: SyncCollectionDto) {
    return this.sync.ingestCollection(dto);
  }

  @Get('inbox')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Staged documents',
    description: 'Inbox rows (default all). Use status=pending|failed to see what has not reached the main tables.',
  })
  @ApiOkResponse({ description: '{ items, total, pending, failed }' })
  list(@Query() q: ListInboxQueryDto) {
    return this.sync.list(q);
  }

  @Patch('inbox/:id')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: "Edit a staged document's payload before re-exporting it",
    description:
      "Replaces the raw payload (e.g. add a RETURN's referenceVoucherNumber, fix a store or quantity). Resets the row to pending and clears the error; call retry to re-promote.",
  })
  @ApiOkResponse({ description: 'The updated inbox row' })
  updatePayload(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInboxPayloadDto,
  ) {
    return this.sync.updatePayload(id, dto.payload);
  }

  @Post('inbox/:id/retry')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Retry promoting a staged document into the main tables' })
  @ApiOkResponse({ description: 'The updated inbox row' })
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.retry(id);
  }

  @Delete('inbox/:id')
  @Roles('admin', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Discard a staged document (does not touch main tables)' })
  @ApiNoContentResponse()
  async discard(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.sync.discard(id);
  }
}
