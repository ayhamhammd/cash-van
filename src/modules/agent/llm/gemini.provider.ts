import { GoogleGenAI } from '@google/genai';
import type { Content, Part } from '@google/genai';

import type {
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmTurnParams,
  LlmTurnResult,
} from './llm.types';

/** Google Gemini implementation of LlmProvider (function calling + streaming). */
export class GeminiProvider implements LlmProvider {
  readonly name = 'Google Gemini';
  readonly apiKeyEnvVar = 'GEMINI_API_KEY';
  private readonly ai: GoogleGenAI | null;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly maxTokens: number,
  ) {
    this.ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  isConfigured(): boolean {
    return this.ai !== null;
  }

  async *streamTurn(
    { system, tools, messages }: LlmTurnParams,
    signal: AbortSignal,
  ): AsyncGenerator<string, LlmTurnResult, void> {
    const ai = this.ai;
    if (!ai) throw new Error('Gemini client not configured');

    const stream = await ai.models.generateContentStream({
      model: this.model,
      contents: messages.map(toGemini),
      config: {
        systemInstruction: system,
        maxOutputTokens: this.maxTokens,
        abortSignal: signal,
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              // Pass the raw JSON Schema (avoids Gemini's enum-typed Schema).
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
      },
    });

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    let idx = 0;
    for await (const chunk of stream) {
      const parts: Part[] = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          text += part.text;
          yield part.text;
        } else if (part.functionCall) {
          toolCalls.push({
            // Gemini omits ids; synthesise a stable one for our event stream.
            id: part.functionCall.id ?? `${part.functionCall.name}-${idx++}`,
            name: part.functionCall.name ?? '',
            input: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }
}

function toGemini(msg: LlmMessage): Content {
  if (msg.role === 'user') {
    return { role: 'user', parts: [{ text: msg.text }] };
  }
  if (msg.role === 'assistant') {
    const parts: Part[] = [];
    if (msg.text) parts.push({ text: msg.text });
    for (const tc of msg.toolCalls) {
      parts.push({ functionCall: { id: tc.id, name: tc.name, args: tc.input } });
    }
    return { role: 'model', parts };
  }
  // tool results → a user turn of functionResponse parts (matched by name)
  return {
    role: 'user',
    parts: msg.results.map((r) => ({
      functionResponse: {
        id: r.id,
        name: r.name,
        response: r.isError
          ? { error: r.output }
          : { output: safeParse(r.output) },
      },
    })),
  };
}

/** Gemini wants a JSON object for the response; parse the tool's JSON string. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
