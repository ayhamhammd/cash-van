import Anthropic from '@anthropic-ai/sdk';

import type {
  LlmMessage,
  LlmProvider,
  LlmTurnParams,
  LlmTurnResult,
} from './llm.types';

/** Claude (Anthropic Messages API) implementation of LlmProvider. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'Anthropic Claude';
  readonly apiKeyEnvVar = 'ANTHROPIC_API_KEY';
  private readonly client: Anthropic | null;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly maxTokens: number,
  ) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async *streamTurn(
    { system, tools, messages }: LlmTurnParams,
    signal: AbortSignal,
  ): AsyncGenerator<string, LlmTurnResult, void> {
    const client = this.client;
    if (!client) throw new Error('Anthropic client not configured');

    const stream = client.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
        messages: messages.map(toAnthropic),
      },
      { signal },
    );

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text;
      }
    }

    const final = await stream.finalMessage();
    let text = '';
    const toolCalls: LlmTurnResult['toolCalls'] = [];
    for (const block of final.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return { text, toolCalls, stopReason: final.stop_reason ?? 'end_turn' };
  }
}

function toAnthropic(msg: LlmMessage): Anthropic.MessageParam {
  if (msg.role === 'user') {
    return { role: 'user', content: msg.text };
  }
  if (msg.role === 'assistant') {
    const content: Anthropic.ContentBlockParam[] = [];
    if (msg.text) content.push({ type: 'text', text: msg.text });
    for (const tc of msg.toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }
    return { role: 'assistant', content };
  }
  // tool results → a user turn of tool_result blocks
  return {
    role: 'user',
    content: msg.results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.id,
      content: r.output,
      is_error: r.isError,
    })),
  };
}
