import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { AgentService } from './agent.service';
import { AgentStoreService } from './store/agent-store.service';
import { AdminGuard } from './guards/admin.guard';
import { ChatDto } from './dto/chat.dto';
import type { AgentEvent } from './agent.types';

@ApiTags('ai-agent')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller({ path: 'agent', version: '1' })
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly store: AgentStoreService,
  ) {}

  @Post('chat')
  @ApiOperation({
    summary: 'Chat with the AI report agent (SSE stream)',
    description:
      'Send a natural-language report request. The response is a Server-Sent ' +
      'Events stream (text/event-stream) sent over POST — consume it with a ' +
      'streaming fetch reader, not EventSource. Event types: `text` (assistant ' +
      'text delta), `tool_start`, `tool_result_summary`, `report_ready` (a ' +
      'downloadable file is ready — see `downloadUrl`), `done` (carries ' +
      '`conversationId` to continue the thread), and `error`.',
  })
  @ApiProduces('text/event-stream')
  async chat(
    @Body() dto: ChatDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx) so events flush immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    const send = (event: AgentEvent): void => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    };

    try {
      for await (const event of this.agent.runChat(
        {
          prompt: dto.prompt,
          conversationId: dto.conversationId,
          userId: user?.sub ?? null,
        },
        abort.signal,
      )) {
        send(event);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        send({
          type: 'error',
          data: { message: err instanceof Error ? err.message : String(err) },
        });
      }
    } finally {
      res.end();
    }
  }

  @Get('reports/:id')
  @ApiOperation({
    summary: 'Download a generated report file',
    description:
      'Streams the report file (xlsx/json/markdown/text) the agent produced, ' +
      'with the right content-type and filename.',
  })
  @ApiOkResponse({ description: 'The report file as an attachment.' })
  async downloadReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { report, buffer } = await this.store.loadReport(id);
    res.setHeader('Content-Type', report.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${report.filename}"`,
    );
    return new StreamableFile(buffer);
  }
}
