import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AiInsightsService } from './ai-insights.service';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin', 'manager', 'supervisor')
@Controller({ path: 'ai', version: '1' })
export class AiInsightsController {
  constructor(private readonly service: AiInsightsService) {}

  @Get('insights')
  @ApiOperation({
    summary: 'Live AI insights',
    description:
      'Briefing, product-velocity forecast, rep recommendations and cheque-OCR stats, computed from live operational data (bilingual).',
  })
  @ApiOkResponse({ description: 'Insights payload' })
  insights() {
    return this.service.insights();
  }
}
