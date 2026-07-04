/**
 * Provider-neutral LLM abstraction so the agent loop is independent of which
 * model vendor is used (Anthropic Claude or Google Gemini). Each provider
 * converts these neutral shapes to/from its native message + tool format.
 */

/** DI token for the configured provider. */
export const LLM_PROVIDER = 'LLM_PROVIDER';

/** A tool the model may call (JSON-Schema parameters). */
export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool invocation the model produced. */
export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running a tool, fed back to the model. */
export interface LlmToolResult {
  id: string;
  name: string;
  /** JSON string of the tool output. */
  output: string;
  isError: boolean;
}

/** One neutral conversation message (persisted as the conversation history). */
export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: LlmToolCall[] }
  | { role: 'tool'; results: LlmToolResult[] };

/** What one assistant turn produced after streaming completes. */
export interface LlmTurnResult {
  text: string;
  toolCalls: LlmToolCall[];
  /** 'tool_use' when the model wants tools run, else 'end_turn' / etc. */
  stopReason: string;
}

export interface LlmTurnParams {
  system: string;
  tools: LlmToolDef[];
  messages: LlmMessage[];
}

/**
 * A model provider. `streamTurn` is an async generator that yields assistant
 * text deltas as they stream and *returns* the assembled turn result (text +
 * tool calls) when the turn ends.
 */
export interface LlmProvider {
  /** Human-readable provider name (for logs/errors). */
  readonly name: string;
  /** The model id in use. */
  readonly model: string;
  /** The env var that supplies this provider's API key (for error messages). */
  readonly apiKeyEnvVar: string;
  /** True when an API key is present. */
  isConfigured(): boolean;

  streamTurn(
    params: LlmTurnParams,
    signal: AbortSignal,
  ): AsyncGenerator<string, LlmTurnResult, void>;
}
