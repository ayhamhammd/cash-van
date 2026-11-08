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
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { DeliveriesService } from './deliveries.service';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DeliveryProofsService, PROOF_UPLOAD_CEILING } from './delivery-proofs.service';
import { DeliveryHistoryQuery, SyncDeliveryDto, SyncDeliveryProofDto } from './dto/deliveries.dto';

/** Send one proof file inline, with its own type, never cached by a shared proxy. */
export function streamProof(
  res: Response,
  f: { buffer: Buffer; mime: string; filename: string },
): StreamableFile {
  res.set({
    'Content-Type': f.mime,
    'Content-Disposition': `inline; filename="${f.filename}"`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  return new StreamableFile(f.buffer);
}

/**
 * The delivery rep's phone (docs/SPEC-delivery-rep.md §6.1). Every route needs
 * a rep token whose rep is DELIVERY or BOTH; anyone else gets 403.
 */
@ApiTags('deliveries')
@ApiBearerAuth()
@Controller({ path: 'deliveries', version: '1' })
export class DeliveriesAppController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly proofs: DeliveryProofsService,
  ) {}

  @Get('my-stops/:stopId/proofs/:proofId')
  @ApiOperation({ summary: 'A proof of one of this rep\'s stops (the file)' })
  async myProof(
    @CurrentUser() user: AuthenticatedUser,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Param('proofId', ParseUUIDPipe) proofId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return streamProof(res, await this.proofs.file(stopId, proofId, 'phone', user));
  }

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
  constructor(
    private readonly intake: DeliveryIntakeService,
    private readonly proofs: DeliveryProofsService,
  ) {}

  @Post('delivery-proofs')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PROOF_UPLOAD_CEILING, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'clientRef', 'stopId', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        clientRef: { type: 'string' },
        stopId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['PHOTO', 'SIGNATURE'] },
        capturedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload one delivery proof (photo or signature) before the result',
    description:
      'Idempotent on clientRef: 201 { proofId, clientRef } the first time, 200 with the same ' +
      'answer after. A photo is JPEG/PNG/WebP ≤ 3 MB, at most 5 per stop; a signature is a ' +
      'PNG ≤ 300 KB. 404 STOP_NOT_FOUND, 422 TOO_MANY_PHOTOS / UNSUPPORTED_TYPE / FILE_TOO_LARGE.',
  })
  @ApiOkResponse({ description: '{ proofId, clientRef }' })
  async uploadProof(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: SyncDeliveryProofDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ proofId: string; clientRef: string }> {
    const out = await this.proofs.upload(file, dto, user);
    res.status(out.created ? HttpStatus.CREATED : HttpStatus.OK);
    return { proofId: out.proofId, clientRef: out.clientRef };
  }

  @Post('deliveries')
  // 202 like sync/vouchers: "the server has durably taken it"; the verdict is in the body.
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "A delivery rep's result for one stop: DELIVERED, PARTIAL or RETURNED, with lines and proofs",
    description:
      'Idempotent on clientRef. 409 { code: STOP_ALREADY_FINAL } when the stop already has a ' +
      'result under another clientRef. A failed check is 202 { status: rejected, reason } with ' +
      'PROOF_MISSING, PROOF_UNKNOWN, OUTCOME_MISMATCH, QTY_OUT_OF_RANGE, REASON_REQUIRED, ' +
      'NOTE_REQUIRED or LINE_UNKNOWN. The proofs, then the result, reach the ERP through the outbox.',
  })
  @ApiOkResponse({ description: "{ status: 'accepted' | 'rejected', reason? }" })
  ingest(@Body() dto: SyncDeliveryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.intake.ingest(dto, user);
  }
}
