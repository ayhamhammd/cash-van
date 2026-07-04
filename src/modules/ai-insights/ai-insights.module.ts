import { Module } from '@nestjs/common';

import { AiInsightsController } from './ai-insights.controller';
import { AiInsightsService } from './ai-insights.service';

/**
 * Live AI insights hub backend (GET /ai/insights). Reads operational data via
 * the shared DataSource; no per-feature entities of its own.
 */
@Module({
  controllers: [AiInsightsController],
  providers: [AiInsightsService],
})
export class AiInsightsModule {}
