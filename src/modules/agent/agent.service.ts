import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AgentToolsService,
  type ToolContext,
} from './tools/agent-tools.service';
import { AgentStoreService } from './store/agent-store.service';
import { ReadonlyDbService } from './db/readonly-db.service';
import { AGENT_TOOL_DEFS } from './tools/tool-definitions';
import { buildSystemPrompt } from './agent.system-prompt';
import {
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
  type LlmToolResult,
} from './llm/llm.types';
import type { AgentEvent, StoredMessage } from './agent.types';

export interface ChatRequest {
  prompt: string;
  conversationId?: string;
  userId: string | null;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly maxIterations: number;
  private tableNamesCache: string[] | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly tools: AgentToolsService,
    private readonly store: AgentStoreService,
    private readonly db: ReadonlyDbService,
  ) {
    this.maxIterations = this.config.get<number>('agent.maxIterations', 8);
  }

  /**
   * Run one chat turn, yielding SSE events as the model streams text, calls
   * tools, and produces reports. Provider-agnostic: the loop talks to the
   * configured LlmProvider (Claude or Gemini).
   */
  async *runChat(
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    if (!this.provider.isConfigured()) {
      yield {
        type: 'error',
        data: {
          message: `AI agent is not configured (${this.provider.apiKeyEnvVar} is missing).`,
        },
      };
      return;
    }

    const convo = await this.store.openConversation(
      req.conversationId,
      req.userId,
    );
    const ctx: ToolContext = { conversationId: convo.id, userId: req.userId };
    const messages: LlmMessage[] = [
      ...convo.messages,
      { role: 'user', text: req.prompt },
    ];
    const system = buildSystemPrompt(await this.getTableNames());
    const reportIds: string[] = [];
    let stopReason = 'end_turn';

    for (let i = 0; i < this.maxIterations; i++) {
      const turn = this.provider.streamTurn(
        { system, tools: AGENT_TOOL_DEFS, messages },
        signal,
      );
      let next = await turn.next();
      while (!next.done) {
        yield { type: 'text', data: { delta: next.value } };
        next = await turn.next();
      }
      const final = next.value;

      messages.push({
        role: 'assistant',
        text: final.text,
        toolCalls: final.toolCalls,
      });
      stopReason = final.stopReason;

      if (final.toolCalls.length === 0) break;

      const results: LlmToolResult[] = [];
      for (const call of final.toolCalls) {
        yield {
          type: 'tool_start',
          data: { id: call.id, name: call.name, input: call.input },
        };

        let outcome;
        let isError = false;
        try {
          outcome = await this.tools.run(call.name, call.input, ctx);
        } catch (err) {
          isError = true;
          outcome = { result: { error: this.errorMessage(err) } };
        }

        yield {
          type: 'tool_result_summary',
          data: {
            id: call.id,
            name: call.name,
            ok: !isError,
            summary: this.summarize(call.name, outcome.result),
          },
        };

        if (outcome.report) {
          reportIds.push(outcome.report.reportId);
          yield { type: 'report_ready', data: outcome.report };
        }

        results.push({
          id: call.id,
          name: call.name,
          output: JSON.stringify(outcome.result),
          isError,
        });
      }

      messages.push({ role: 'tool', results });

      if (i === this.maxIterations - 1) {
        stopReason = 'max_iterations';
        yield {
          type: 'text',
          data: {
            delta:
              '\n\n_(Reached the tool-use limit for this turn. Ask me to continue if needed.)_',
          },
        };
      }
    }

    await this.persist(convo, messages, req.prompt);

    yield {
      type: 'done',
      data: { conversationId: convo.id, reportIds, stopReason },
    };
  }

  private async persist(
    convo: { id: string; isNew: boolean },
    messages: StoredMessage[],
    prompt: string,
  ): Promise<void> {
    try {
      const title = convo.isNew ? prompt.slice(0, 80) : null;
      await this.store.saveConversation(convo.id, messages, title);
    } catch (err) {
      this.logger.error(
        `Failed to persist conversation: ${this.errorMessage(err)}`,
      );
    }
  }

  /** Table names for the system-prompt hint (full schema is a tool call). */
  private async getTableNames(): Promise<string[]> {
    if (this.tableNamesCache) return this.tableNamesCache;
    try {
      const res = await this.db.runSelect(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
        [],
        1000,
      );
      this.tableNamesCache = res.rows
        .map((r) => String(r.table_name))
        .filter(
          (t) =>
            ![
              'migrations',
              'typeorm_metadata',
              'agent_conversations',
              'agent_reports',
            ].includes(t),
        );
    } catch (err) {
      this.logger.warn(
        `Could not preload table names: ${this.errorMessage(err)}`,
      );
      this.tableNamesCache = [];
    }
    return this.tableNamesCache;
  }

  private summarize(name: string, result: unknown): string {
    const r = result as Record<string, unknown> | undefined;
    if (r && typeof r.error === 'string') return `error: ${r.error}`;
    switch (name) {
      case 'get_schema':
        return 'schema returned';
      case 'run_sql':
        return `${r?.previewRowCount ?? 0} preview row(s)${r?.hasMoreRows ? ' (more available)' : ''}`;
      case 'generate_report':
        return `report ${r?.filename ?? ''} (${r?.rowCount ?? 0} rows)`;
      default:
        return 'done';
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
