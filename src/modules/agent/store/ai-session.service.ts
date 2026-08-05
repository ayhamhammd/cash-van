import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentConversation } from '../entities/agent-conversation.entity';
import { AgentReport } from '../entities/agent-report.entity';
import { AiMessage } from '../entities/ai-message.entity';

/** A row in the sessions sidebar. No transcript — that needs its own fetch. */
export interface SessionSummary {
  id: string;
  title: string | null;
  persona: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDetail extends SessionSummary {
  messages: AiMessage[];
  artifacts: ArtifactSummary[];
}

export interface ArtifactSummary {
  id: string;
  title: string | null;
  format: string;
  filename: string;
  rowCount: number;
  createdAt: Date;
  downloadUrl: string;
}

/** One turn to append to the message index. */
export interface TurnRecord {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: string | null;
  toolName?: string | null;
  toolInput?: Record<string, unknown> | null;
  toolSummary?: Record<string, unknown> | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
}

/**
 * Session-level reads and the per-message index.
 *
 * Separate from AgentStoreService on purpose: that one owns the replay path
 * (the provider-native blob) and must stay boring. This one owns everything the
 * UI needs and is free to change shape as the page grows.
 */
@Injectable()
export class AiSessionService {
  constructor(
    @InjectRepository(AgentConversation)
    private readonly conversations: Repository<AgentConversation>,
    @InjectRepository(AiMessage)
    private readonly messages: Repository<AiMessage>,
    @InjectRepository(AgentReport)
    private readonly reports: Repository<AgentReport>,
  ) {}

  /**
   * Newest first, archived excluded, and empties hidden.
   *
   * A thread row is created before the first model call, so a turn that fails
   * — no API credit, a bad key, a network drop — leaves a titled-nothing,
   * said-nothing session behind. Those accumulate in the sidebar and are
   * indistinguishable from real history, so the list requires either a stored
   * transcript or a title before a session is worth showing.
   */
  async list(limit = 50, offset = 0): Promise<SessionSummary[]> {
    const rows = await this.conversations
      .createQueryBuilder('c')
      .where('c.archived_at IS NULL')
      .andWhere(
        "(jsonb_array_length(c.messages) > 0 OR c.title IS NOT NULL)",
      )
      .orderBy('c.updated_at', 'DESC')
      .take(Math.min(limit, 200))
      .skip(offset)
      .getMany();
    if (rows.length === 0) return [];

    // One grouped count rather than a count per row: a sidebar of 50 sessions
    // should not be 50 round trips.
    const counts = await this.messages
      .createQueryBuilder('m')
      .select('m.conversation_id', 'id')
      .addSelect('COUNT(*)::int', 'n')
      .where('m.conversation_id IN (:...ids)', { ids: rows.map((r) => r.id) })
      .groupBy('m.conversation_id')
      .getRawMany<{ id: string; n: number }>();
    const byId = new Map(counts.map((c) => [c.id, c.n]));

    return rows.map((r) => this.toSummary(r, byId.get(r.id) ?? 0));
  }

  async detail(id: string): Promise<SessionDetail> {
    const convo = await this.conversations.findOne({ where: { id } });
    if (!convo) throw new NotFoundException(`Session not found: ${id}`);

    const [messages, reports] = await Promise.all([
      this.messages.find({
        where: { conversationId: id },
        order: { seq: 'ASC' },
      }),
      this.reports.find({
        where: { conversationId: id },
        order: { createdAt: 'ASC' },
      }),
    ]);

    return {
      ...this.toSummary(convo, messages.length),
      messages,
      artifacts: reports.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        format: r.format,
        filename: r.filename,
        rowCount: r.rowCount,
        createdAt: r.createdAt,
        downloadUrl: `/api/v1/agent/reports/${r.id}`,
      })),
    };
  }

  async rename(id: string, title: string): Promise<void> {
    const res = await this.conversations.update(id, { title });
    if (!res.affected) throw new NotFoundException(`Session not found: ${id}`);
  }

  /** Hide from the list, keep the transcript. */
  async archive(id: string): Promise<void> {
    const res = await this.conversations.update(id, { archivedAt: new Date() });
    if (!res.affected) throw new NotFoundException(`Session not found: ${id}`);
  }

  /** Really gone. ai_messages cascades; report rows keep their files. */
  async remove(id: string): Promise<void> {
    const res = await this.conversations.delete(id);
    if (!res.affected) throw new NotFoundException(`Session not found: ${id}`);
  }

  /**
   * Append one turn's worth of rows and add the tokens to the session total.
   *
   * Sequence numbers come from the current max rather than a counter column, so
   * a failed write leaves no gap that a later read would trip over. Index
   * writes are best-effort by design — see appendSafe.
   */
  async append(
    conversationId: string,
    records: TurnRecord[],
    meta: { model?: string | null; persona?: string | null } = {},
  ): Promise<void> {
    if (records.length === 0) return;

    const { max } = await this.messages
      .createQueryBuilder('m')
      .select('COALESCE(MAX(m.seq), 0)', 'max')
      .where('m.conversation_id = :conversationId', { conversationId })
      .getRawOne<{ max: string }>() ?? { max: '0' };
    let seq = Number(max ?? 0);

    await this.messages.save(
      records.map((r) =>
        this.messages.create({
          conversationId,
          seq: ++seq,
          role: r.role,
          content: r.content ?? null,
          toolName: r.toolName ?? null,
          toolInput: r.toolInput ?? null,
          toolSummary: r.toolSummary ?? null,
          inputTokens: r.inputTokens ?? null,
          outputTokens: r.outputTokens ?? null,
          error: r.error ?? null,
        }),
      ),
    );

    const inTok = records.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    const outTok = records.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
    if (inTok || outTok || meta.model || meta.persona) {
      // Increment in SQL, not read-modify-write: two turns finishing close
      // together would otherwise lose one of the counts.
      await this.conversations
        .createQueryBuilder()
        .update(AgentConversation)
        .set({
          inputTokens: () => `"input_tokens" + ${Math.trunc(inTok)}`,
          outputTokens: () => `"output_tokens" + ${Math.trunc(outTok)}`,
          ...(meta.model ? { model: meta.model } : {}),
          ...(meta.persona ? { persona: meta.persona } : {}),
        })
        .where('id = :id', { id: conversationId })
        .execute();
    }
  }

  private toSummary(c: AgentConversation, messageCount: number): SessionSummary {
    return {
      id: c.id,
      title: c.title ?? null,
      persona: c.persona ?? 'analyst',
      model: c.model ?? null,
      // bigint arrives as a string from pg; the UI wants a number.
      inputTokens: Number(c.inputTokens ?? 0),
      outputTokens: Number(c.outputTokens ?? 0),
      messageCount,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
