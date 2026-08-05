import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per turn, as an INDEX over the conversation.
 *
 * The authoritative transcript stays in `agent_conversations.messages` (the
 * provider-native blob the loop replays). This table exists for the things a
 * blob cannot do: cost per turn, searching history, and tying an artifact to
 * the message that produced it. Treat it as derived — it can be rebuilt.
 */
@Entity({ name: 'ai_messages' })
@Index('idx_ai_messages_conversation', ['conversationId', 'seq'])
export class AiMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  /** 1-based position in the thread; unique per conversation. */
  @Column({ type: 'integer' })
  seq!: number;

  @Column({ type: 'text' })
  role!: 'user' | 'assistant' | 'tool' | 'system';

  @Column({ type: 'text', nullable: true })
  content?: string | null;

  @Column({ name: 'tool_name', type: 'text', nullable: true })
  toolName?: string | null;

  @Column({ name: 'tool_input', type: 'jsonb', nullable: true })
  toolInput?: Record<string, unknown> | null;

  /**
   * A PREVIEW of the tool output — row counts and a handful of rows. Never the
   * full result: a SELECT can return tens of thousands of rows and this is a
   * jsonb column, not a data warehouse. The artifact holds the real payload.
   */
  @Column({ name: 'tool_summary', type: 'jsonb', nullable: true })
  toolSummary?: Record<string, unknown> | null;

  @Column({ name: 'input_tokens', type: 'integer', nullable: true })
  inputTokens?: number | null;

  @Column({ name: 'output_tokens', type: 'integer', nullable: true })
  outputTokens?: number | null;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
