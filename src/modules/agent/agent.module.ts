import { Module } from '@nestjs/common';
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
import { AiProviderResolver } from './llm/ai-provider.resolver';

/**
 * AI report agent: natural-language prompt → read-only SELECT → rendered report.
 * The LLM provider (Anthropic / OpenAI / Gemini) is resolved per request by
 * AiProviderResolver — from the Settings AI config first, else env. Relies on
 * the global StorageService for report bytes and the global SettingsService.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentConversation, AgentReport])],
  controllers: [AgentController],
  providers: [
    AiProviderResolver,
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
