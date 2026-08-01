import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { QuoteTemplatesService } from './quote-templates.service';
import { ProspectsService } from './prospects.service';
import {
  CreateQuoteTemplateDto,
  UpdateQuoteTemplateDto,
} from './dto/quote-template.dto';

/** Guards the tracking param — ParseUUIDPipe can't be used on an optional query. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('prospecting')
@ApiBearerAuth()
@Controller({ path: 'quote-templates', version: '1' })
export class QuoteTemplatesController {
  constructor(
    private readonly templates: QuoteTemplatesService,
    private readonly prospects: ProspectsService,
  ) {}

  // Declared before ':id' so the static prefix wins route matching.
  @Get('public/:token')
  @Public()
  @ApiOperation({
    summary: 'Resolve a quote by its public token (no auth)',
    description:
      'Backs the public quote page (/q/<token>) that prospects open from the ' +
      'WhatsApp link. Returns presentation fields only; 404 for unknown, ' +
      'inactive or deleted templates. An optional ?p=<prospectId> records the ' +
      'first open against that prospect (outreach tracking).',
  })
  @ApiParam({ name: 'token' })
  @ApiQuery({ name: 'p', required: false, description: 'Prospect id to track.' })
  @ApiOkResponse({ description: 'Quote presentation data' })
  async resolvePublic(
    @Param('token') token: string,
    @Query('p') prospectId?: string,
  ) {
    const quote = await this.templates.findByToken(token);
    // Fire-and-forget: a bad/stale prospect id must never break the prospect's
    // view of the quote, so tracking failures are swallowed.
    if (prospectId && UUID_RE.test(prospectId)) {
      await this.prospects.markLinkOpened(prospectId).catch(() => undefined);
    }
    return quote;
  }

  @Get()
  @ApiOperation({ summary: 'List quote templates (paginated, name search)' })
  @ApiOkResponse({ description: 'Templates page' })
  list(@Query() query: PaginationDto) {
    return this.templates.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one quote template' })
  @ApiOkResponse({ description: 'The template' })
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.findOne(id);
  }

  @Post()
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Create quote template',
    description: 'Generates the stable public token server-side.',
  })
  @ApiCreatedResponse({ description: 'Template created' })
  create(@Body() dto: CreateQuoteTemplateDto) {
    return this.templates.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Update quote template',
    description: 'The public token never changes — sent links keep working.',
  })
  @ApiOkResponse({ description: 'Template updated' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuoteTemplateDto,
  ) {
    return this.templates.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('canManageOffers')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete quote template' })
  @ApiNoContentResponse({ description: 'Deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.templates.remove(id);
  }
}
