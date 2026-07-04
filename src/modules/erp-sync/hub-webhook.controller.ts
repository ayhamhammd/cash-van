import {
  Controller,
  Post,
  Req,
  Res,
  RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { HubWebhookService } from './hub-webhook.service';

@ApiTags('webhooks')
@Controller({ path: 'webhooks', version: '1' })
export class HubWebhookController {
  constructor(private readonly service: HubWebhookService) {}

  @Public()
  @Post('hub')
  @ApiOperation({
    summary: 'Integration Hub webhook receiver (Hub → Van)',
    description:
      'Verifies X-Hub-Signature (HMAC-SHA256 over `${X-Hub-Timestamp}.${rawBody}`), dedupes, and dispatches the event. Public — the signature is the auth.',
  })
  async hub(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
    }
    const result = await this.service.receive(rawBody, headers);
    res.status(result.httpStatus).json(result.body);
  }
}
