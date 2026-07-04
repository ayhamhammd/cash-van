import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SettingsService } from '../../settings/settings.service';
import type { LlmProvider } from './llm.types';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { GeminiProvider } from './gemini.provider';

/**
 * Resolves the active LLM provider per request. Priority:
 *   1) the Settings-configured provider + key (admin sets it in the AI Config UI),
 *   2) else the env-configured provider (legacy: LLM_PROVIDER + *_API_KEY).
 * This lets an admin switch between Anthropic / OpenAI / Gemini and rotate the
 * key from the dashboard without a redeploy.
 */
@Injectable()
export class AiProviderResolver {
  private readonly logger = new Logger(AiProviderResolver.name);

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  async resolve(): Promise<LlmProvider> {
    const maxTokens = this.config.get<number>('agent.maxTokens', 4096);

    try {
      const ai = await this.settings.getAiConfig();
      if (ai.enabled && ai.apiKey) {
        return this.build(ai.provider, ai.apiKey, ai.model, maxTokens);
      }
    } catch (err) {
      // Settings row missing (migration pending) etc. → fall back to env.
      this.logger.warn(`AI settings unavailable, using env provider: ${String(err)}`);
    }

    const which = this.config.get<string>('llm.provider', 'anthropic').toLowerCase();
    if (which === 'gemini') {
      return new GeminiProvider(
        this.config.get<string>('gemini.apiKey', ''),
        this.config.get<string>('gemini.model', 'gemini-2.5-flash'),
        maxTokens,
      );
    }
    if (which === 'openai') {
      return new OpenAiProvider(
        this.config.get<string>('openai.apiKey', ''),
        this.config.get<string>('openai.model', 'gpt-4o'),
        maxTokens,
      );
    }
    return new AnthropicProvider(
      this.config.get<string>('agent.apiKey', ''),
      this.config.get<string>('agent.model', 'claude-sonnet-4-6'),
      maxTokens,
    );
  }

  private build(
    provider: string,
    apiKey: string,
    model: string | null,
    maxTokens: number,
  ): LlmProvider {
    switch ((provider || 'anthropic').toLowerCase()) {
      case 'openai':
        return new OpenAiProvider(apiKey, model || 'gpt-4o', maxTokens);
      case 'gemini':
        return new GeminiProvider(apiKey, model || 'gemini-2.5-flash', maxTokens);
      default:
        return new AnthropicProvider(apiKey, model || 'claude-sonnet-4-6', maxTokens);
    }
  }
}
