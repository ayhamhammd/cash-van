import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { DeliveriesService } from './deliveries.service';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DeliveryHistoryQuery, SyncDeliveryDto } from './dto/deliveries.dto';

/**
 * The delivery rep's phone (docs/SPEC-delivery-rep.md §6.1). Every route needs
 * a rep token whose rep is DELIVERY or BOTH; anyone else gets 403.
 */
@ApiTags('deliveries')
@ApiBearerAuth()
@Controller({ path: 'deliveries', version: '1' })
export class DeliveriesAppController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get('mine')
  @ApiOperation({ summary: "This rep's open runs, plus stops he finished in the last 2 days" })
  @ApiOkResponse({ description: '{ runs: RunDetail[], serverTime }' })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.deliveries.mine(user);
  }

  @Get('history')
  @ApiOperation({ summary: "This rep's delivered history, paged" })
  @ApiOkResponse({ description: '{ items: (Stop & { run: { id, runNumber, runDate } })[], total }' })
  history(@CurrentUser() user: AuthenticatedUser, @Query() q: DeliveryHistoryQuery) {
    return this.deliveries.history(user, q);
  }

  @Get('stops/:id')
  @ApiOperation({ summary: 'One stop of this rep, fresh from the mirror' })
  @ApiOkResponse({ description: 'Stop' })
  stop(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.appStop(user, id);
  }
}

/** `POST sync/deliveries` — next to the phone's other intakes. */
@ApiTags('sync')
@ApiBearerAuth()
@Controller({ path: 'sync', version: '1' })
export class DeliverySyncController {
  constructor(private readonly intake: DeliveryIntakeService) {}

  @Post('deliveries')
  // 202 like sync/vouchers: "the server has durably taken it"; the verdict is in the body.
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "A delivery rep's result for one stop (whole invoice: DELIVERED or RETURNED)",
    description:
      'Idempotent on clientRef. 409 { code: STOP_ALREADY_FINAL } when the stop already has a ' +
      'result under another clientRef. The result reaches the ERP through the outbox.',
  })
  @ApiOkResponse({ description: "{ status: 'accepted' | 'rejected', reason? }" })
  ingest(@Body() dto: SyncDeliveryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.intake.ingest(dto, user);
  }
}
