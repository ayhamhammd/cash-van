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
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { OffersService } from './offers.service';
import { OffersEngineService } from './offers-engine.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { UpdateOfferDto } from './dto/update-offer.dto';
import { ListOffersQueryDto } from './dto/list-offers.dto';
import { EvaluateOffersDto } from './dto/evaluate-offers.dto';

@ApiTags('offers')
@ApiBearerAuth()
@Controller({ path: 'offers', version: '1' })
export class OffersController {
  constructor(
    private readonly offers: OffersService,
    private readonly engine: OffersEngineService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List offers',
    description: 'Paginated, filterable by status/type/search. Includes stat counts.',
  })
  @ApiOkResponse({ description: 'Offers page + stats' })
  list(@Query() query: ListOffersQueryDto) {
    return this.offers.findAll(query);
  }

  @Post()
  @RequirePermissions('canManageOffers')
  @ApiOperation({
    summary: 'Create offer',
    description: 'Type-first definition. Rejects rewards illegal for the chosen type.',
  })
  @ApiCreatedResponse({ description: 'Offer created' })
  create(@Body() dto: CreateOfferDto) {
    return this.offers.create(dto);
  }

  @Post('evaluate')
  @ApiOperation({
    summary: 'Evaluate offers against a cart (preview)',
    description:
      'Authoritative discount computation. Returns per-line discounts, free lines, ' +
      'invoice discount and the applied offers. Available to any authenticated user ' +
      '(the sale device calls this).',
  })
  @ApiOkResponse({ description: 'Evaluation result' })
  evaluate(@Body() dto: EvaluateOffersDto) {
    return this.engine.evaluate(dto.lines, {
      customerNumber: dto.customerNumber,
      repId: dto.repId,
      storeNumber: dto.storeNumber,
      paymentMethod: dto.paymentMethod,
      chosenFreeItems: dto.chosenFreeItems,
      at: dto.at ? new Date(dto.at) : undefined,
    });
  }

  @Get('active')
  @ApiOperation({
    summary: 'List currently-active offers (client cache/sync)',
    description:
      'Plain array of offers whose schedule is live now, for the sale device to ' +
      'cache. Optional storeNumber narrows to offers scoped to that store. ' +
      'Eligibility/limits remain authoritative at /offers/evaluate.',
  })
  @ApiOkResponse({ description: 'Active offers' })
  activeOffers(
    @Query('customerNumber') customerNumber?: string,
    @Query('storeNumber') storeNumber?: string,
  ) {
    return this.offers.findActive(customerNumber, storeNumber);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one offer' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'The offer' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.offers.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('canManageOffers')
  @ApiOperation({ summary: 'Update offer', description: 'Re-validates config when type/trigger/reward change.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Updated offer' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOfferDto,
  ) {
    return this.offers.update(id, dto);
  }

  @Post(':id/toggle')
  @RequirePermissions('canManageOffers')
  @ApiOperation({ summary: 'Toggle offer active/paused' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Offer with flipped isActive' })
  toggle(@Param('id', ParseUUIDPipe) id: string) {
    return this.offers.toggle(id);
  }

  @Delete(':id')
  @RequirePermissions('canManageOffers')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete offer (soft)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Offer soft-deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.offers.remove(id);
  }

  @Get(':id/redemptions')
  @ApiOperation({
    summary: 'Per-offer redemption report',
    description: 'Redemptions for an offer (voucher, customer, discount, free items) + totals.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Redemptions page + totals' })
  redemptions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationDto,
  ) {
    return this.offers.redemptions(id, query.page ?? 1, query.limit ?? 25);
  }
}
