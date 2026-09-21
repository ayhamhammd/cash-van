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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { SyncService } from './sync.service';
import {
  ListInboxQueryDto,
  SyncCollectionDto,
  SyncStatusQueryDto,
  SyncVoucherDto,
  SyncVoucherResultDto,
  UpdateInboxPayloadDto,
} from './dto/sync.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('vouchers')
  // 202, not 201: this answers "the server has durably taken responsibility",
  // which is not the same as "the document posted". The verdict is in the body.
  // A rejected document used to travel inside a 201, so a handset keying on the
  // status code recorded it as synced and dropped its only copy.
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Stage & post a voucher from the mobile app',
    description:
      'The app posts here instead of /vouchers. The server assigns the authoritative voucher number (returned immediately) and promotes the row into the main tables. Pass clientRef for idempotent retries. ' +
      'The salesman the document belongs to is taken from the TOKEN — a body `userCode` naming anyone else is refused unless the caller may act on their behalf.',
  })
  @ApiOkResponse({ type: SyncVoucherResultDto })
  ingestVoucher(
    @Body() dto: SyncVoucherDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sync.ingestVoucher(dto, user);
  }

  @Post('collections')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Stage & post a collection from the mobile app',
    description:
      'Same staging flow for cash/cheque collections. Pass clientRef for idempotency. ' +
      'As with vouchers, the acting salesman comes from the token, not from the body.',
  })
  @ApiOkResponse({ type: SyncVoucherResultDto })
  ingestCollection(
    @Body() dto: SyncCollectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sync.ingestCollection(dto, user);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Has the server got these documents?',
    description:
      'The reconciliation endpoint for the handset outbox. Pass every clientRef ' +
      'still held locally; the reply says which posted, which are still staged, ' +
      'and which were rejected. A ref MISSING from the reply never reached the ' +
      'server and must be re-posted — that is the case the app could not ' +
      'previously distinguish from success.',
  })
  @ApiOkResponse({ description: '{ items: SyncVoucherResultDto[] }' })
  status(@Query() q: SyncStatusQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const refs = (q.clientRefs ?? '').split(',').slice(0, 200);
    return this.sync.statusFor(refs, user);
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
