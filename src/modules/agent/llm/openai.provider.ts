import type {
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmTurnParams,
  LlmTurnResult,
} from './llm.types';

/**
 * OpenAI (ChatGPT) implementation of LlmProvider — Chat Completions streaming
 * with function/tool calling, over plain fetch (no SDK dependency). Streams
 * text deltas and assembles tool calls (whose JSON arguments arrive in pieces)
 * by their delta index.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'OpenAI ChatGPT';
  readonly apiKeyEnvVar = 'OPENAI_API_KEY';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly maxTokens: number,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async *streamTurn(
    { system, tools, messages }: LlmTurnParams,
    signal: AbortSignal,
  ): AsyncGenerator<string, LlmTurnResult, void> {
    if (!this.apiKey) throw new Error('OpenAI client not configured');

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      stream: true,
      messages: [
        { role: 'system', content: system },
        ...messages.flatMap(toOpenAi),
      ],
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${detail.slice(0, 300)}`);
    }

    // Tool calls arrive across chunks; accumulate by delta index.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    let text = '';
    let finishReason = 'stop';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk: OpenAiStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiStreamChunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield delta.content;
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot =
            partial.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          partial.set(tc.index, slot);
        }
      }
    }

    const toolCalls: LlmToolCall[] = [...partial.values()].map((s, i) => ({
      id: s.id || `${s.name}-${i}`,
      name: s.name,
      input: safeParseObject(s.args),
    }));

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : finishReason,
    };
  }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function toOpenAi(msg: LlmMessage): OpenAiMessage[] {
  if (msg.role === 'user') return [{ role: 'user', content: msg.text }];
  if (msg.role === 'assistant') {
    const m: OpenAiMessage = { role: 'assistant', content: msg.text || null };
    if (msg.toolCalls.length) {
      m.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
    }
    return [m];
  }
  // tool results → one OpenAI 'tool' message each (matched by tool_call_id)
  return msg.results.map((r) => ({
    role: 'tool' as const,
    tool_call_id: r.id,
    content: r.output,
  }));
}

function safeParseObject(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
