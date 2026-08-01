import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { ProspectsService } from './prospects.service';
import { PlacesService } from './places.service';
import { WhatsappService } from './whatsapp.service';
import { PROSPECT_CATEGORIES } from './prospecting.types';
import {
  ConvertProspectDto,
  CreateProspectSearchDto,
  GeocodeQueryDto,
  ListProspectsQueryDto,
  SendQuoteDto,
  UpdateProspectDto,
} from './dto/prospect.dto';

@ApiTags('prospecting')
@ApiBearerAuth()
@Controller({ path: 'prospecting', version: '1' })
export class ProspectsController {
  constructor(
    private readonly prospects: ProspectsService,
    private readonly places: PlacesService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Get('geocode')
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Find a location by name to move the search point',
    description:
      'Free-text place lookup (Places searchText), biased to the configured ' +
      'region. Runs server-side so the Places key stays off the browser. ' +
      'Billed per call, so the dashboard debounces and only queries on demand.',
  })
  @ApiOkResponse({ description: 'Candidate locations with coordinates' })
  geocode(@Query() query: GeocodeQueryDto) {
    return this.places.searchText(query.q);
  }

  @Get('whatsapp/status')
  @ApiOperation({
    summary: 'WhatsApp gateway health',
    description:
      'Whether the OpenWA gateway is configured, reachable and its session ' +
      'connected, plus how much of the daily send budget is left. The ' +
      'dashboard uses this to decide between server-side sending and a ' +
      'click-to-chat fallback.',
  })
  @ApiOkResponse({ description: 'Gateway status snapshot' })
  whatsappStatus() {
    return this.whatsapp.status();
  }

  @Get('categories')
  @ApiOperation({ summary: 'Searchable business categories (allow-list)' })
  @ApiOkResponse({ description: 'Google Places types offered in the UI' })
  categories() {
    return { categories: PROSPECT_CATEGORIES };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Pipeline counters' })
  @ApiOkResponse({ description: 'Counts per status + opened/existing' })
  stats() {
    return this.prospects.stats();
  }

  @Get('searches')
  @ApiOperation({ summary: 'Recent searches' })
  @ApiOkResponse({ description: 'Last 50 searches' })
  searches() {
    return this.prospects.listSearches();
  }

  @Post('searches')
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Run a lead-finder search',
    description:
      'Calls Google Places server-side, looks up phones, de-dups against ' +
      'existing customers, and upserts the prospects (re-searching an area ' +
      'refreshes leads without losing their status or notes).',
  })
  @ApiCreatedResponse({ description: 'The search + its prospects' })
  search(
    @Body() dto: CreateProspectSearchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prospects.search(dto, user?.sub);
  }

  @Get('prospects')
  @ApiOperation({ summary: 'List prospects (filterable, paginated)' })
  @ApiOkResponse({ description: 'Prospects page' })
  list(@Query() query: ListProspectsQueryDto) {
    return this.prospects.listProspects(query);
  }

  @Get('prospects/:id')
  @ApiOperation({ summary: 'Get one prospect' })
  @ApiOkResponse({ description: 'The prospect' })
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.prospects.findOne(id);
  }

  @Patch('prospects/:id')
  @RequirePermissions('canManageOffers')
  @ApiOperation({ summary: 'Update status / notes' })
  @ApiOkResponse({ description: 'Updated' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProspectDto,
  ) {
    return this.prospects.update(id, dto);
  }

  @Post('prospects/:id/mark-sent')
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Record that the quote was sent on WhatsApp',
    description:
      'Called when the rep opens the click-to-chat link. Stamps sentAt and ' +
      'moves NEW/QUOTED to CONTACTED (never regresses a converted lead).',
  })
  @ApiOkResponse({ description: 'Updated' })
  markSent(@Param('id', ParseUUIDPipe) id: string) {
    return this.prospects.markSent(id);
  }

  @Post('prospects/:id/send-whatsapp')
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Send the quote on WhatsApp via the OpenWA gateway',
    description:
      'Composes the message server-side from the quote template (body + ' +
      'tracked /q link) and sends it through the gateway, then marks the ' +
      'lead contacted. Sends are paced and capped per day to protect the ' +
      'number: this drives an unofficial WhatsApp session, and blasting cold ' +
      'numbers is the fastest route to a permanent restriction. Returns 503 ' +
      'when the gateway is unconfigured or its session is not scanned.',
  })
  @ApiCreatedResponse({ description: 'Sent; prospect marked CONTACTED' })
  sendWhatsApp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendQuoteDto,
  ) {
    return this.prospects.sendQuote(id, dto);
  }

  @Post('prospects/:id/convert')
  @RequirePermissions('canAddCustomer')
  @ApiOperation({
    summary: 'Convert a prospect into a customer',
    description: 'Creates the customer from the prospect and links them.',
  })
  @ApiCreatedResponse({ description: 'The created customer' })
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertProspectDto,
  ) {
    return this.prospects.convert(id, dto);
  }
}
