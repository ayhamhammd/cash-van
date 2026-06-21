import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolsService } from './tools/agent-tools.service';
import { AgentStoreService } from './store/agent-store.service';
import { ReadonlyDbService } from './db/readonly-db.service';
import { ReportRendererService } from './reports/report-renderer.service';
import { SqlValidator } from './sql/sql-validator';
import { AdminGuard } from './guards/admin.guard';
import { AgentConversation } from './entities/agent-conversation.entity';
import { AgentReport } from './entities/agent-report.entity';
import { LLM_PROVIDER, type LlmProvider } from './llm/llm.types';
import { AnthropicProvider } from './llm/anthropic.provider';
import { GeminiProvider } from './llm/gemini.provider';

/**
 * Picks the LLM provider from config. `LLM_PROVIDER=gemini` uses Google Gemini;
 * anything else (default) uses Anthropic Claude. Only the selected provider's
 * API key is needed.
 */
const llmProviderFactory = {
  provide: LLM_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): LlmProvider => {
    const maxTokens = config.get<number>('agent.maxTokens', 4096);
    const which = config.get<string>('llm.provider', 'anthropic').toLowerCase();
    if (which === 'gemini') {
      return new GeminiProvider(
        config.get<string>('gemini.apiKey', ''),
        config.get<string>('gemini.model', 'gemini-2.5-flash'),
        maxTokens,
      );
    }
    return new AnthropicProvider(
      config.get<string>('agent.apiKey', ''),
      config.get<string>('agent.model', 'claude-sonnet-4-6'),
      maxTokens,
    );
  },
};

/**
 * AI report agent: natural-language prompt → read-only SELECT → rendered report.
 * Self-contained module; relies on the global StorageService for report bytes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentConversation, AgentReport])],
  controllers: [AgentController],
  providers: [
    llmProviderFactory,
    AgentService,
    AgentToolsService,
    AgentStoreService,
    ReadonlyDbService,
    ReportRendererService,
    SqlValidator,
    AdminGuard,
  ],
})
export class AgentModule {}
