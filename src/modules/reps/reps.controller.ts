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
  UseGuards,
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

import { RepsService } from './reps.service';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { CreateRepDto } from './dto/create-rep.dto';
import { UpdateRepDto } from './dto/update-rep.dto';
import { ListRepsQuery } from './dto/list-reps.query';
import { ActivateRepDto } from './dto/activate-rep.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RepScopeService } from '../users/rep-scope.service';

@ApiTags('reps')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reps', version: '1' })
export class RepsController {
  constructor(
    private readonly reps: RepsService,
    private readonly erp: ErpSyncService,
    private readonly repScope: RepScopeService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List reps',
    description: 'List sales reps with optional filters and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated rep list' })
  async list(@Query() query: ListRepsQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.reps.list(query, await this.repScope.visibleRepIds(user));
  }

  @Get('me')
  @ApiOperation({
    summary: 'Get my rep profile',
    description:
      'Resolve the field rep linked to the currently authenticated user. Returns 404 if the user is not linked to any rep.',
  })
  @ApiOkResponse({ description: "The current user's rep" })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.reps.findByUserIdOrThrow(user.sub);
  }

  @Get('me/kpis')
  @ApiOperation({
    summary: 'My KPIs',
    description: "KPI snapshot for the current user's rep. 404 if the user isn't a rep.",
  })
  @ApiOkResponse({ description: 'KPI snapshot for the current rep' })
  myKpis(@CurrentUser() user: AuthenticatedUser) {
    return this.reps.kpisForUser(user.sub);
  }

  @Get('me/materials-by-warehouse')
  @ApiOperation({
    summary: 'My materials, grouped by warehouse',
    description:
      "The signed-in rep's van materials and how much of each every warehouse " +
      'holds, the rep\'s own van first. Read-only.',
  })
  @ApiOkResponse({ description: "The rep's materials grouped by warehouse" })
  async myMaterials(@CurrentUser() user: AuthenticatedUser) {
    const rep = await this.reps.findByUserIdOrThrow(user.sub);
    return this.reps.materialsByWarehouse(rep.id);
  }

  @Get('me/erp-balance')
  @ApiOperation({
    summary: 'My balance from the ERP (live)',
    description:
      "The signed-in salesman's linked ERP GL account balance (the \"cash with " +
      'salesman" account), read live from the ERP. Pair it with the cash-van cash ' +
      'summary to show both the ERP figure and the on-hand custody figure. Returns ' +
      '{ source: "erp" | "unavailable" }.',
  })
  @ApiOkResponse({ description: 'Live ERP balance envelope for the current rep' })
  async myErpBalance(@CurrentUser() user: AuthenticatedUser) {
    const rep = await this.reps.findByUserIdOrThrow(user.sub);
    return this.erp.repErpBalanceById(rep.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get rep', description: 'Fetch a single rep by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'The rep' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.repScope.assertCanSeeRep(user, id);
    return this.reps.findOne(id);
  }

  @Get(':id/materials-by-warehouse')
  @ApiOperation({
    summary: "A rep's materials, grouped by warehouse",
    description:
      "The rep's van materials and how much of each every warehouse holds. " +
      'Read-only, rep-scoped.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: "The rep's materials grouped by warehouse" })
  async materialsByWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reps.materialsByWarehouse(id, await this.repScope.visibleRepIds(user));
  }

  @Get(':id/erp-balance')
  @ApiOperation({
    summary: "A rep's balance from the ERP (live)",
    description:
      "The rep's linked ERP GL account balance (\"cash with salesman\"), read live " +
      'from the ERP. Rep-scoped. Returns { source: "erp" | "unavailable" }.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Live ERP balance envelope for the rep' })
  async erpBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.repScope.assertCanSeeRep(user, id);
    return this.erp.repErpBalanceById(id);
  }

  @Get(':id/kpis')
  @ApiOperation({
    summary: 'Rep KPIs',
    description: 'KPI snapshot for a rep (sales, visits, collection metrics).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'KPI snapshot' })
  async kpis(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.repScope.assertCanSeeRep(user, id);
    return this.reps.kpis(id);
  }

  @Post()
  @Roles('admin', 'manager')
  @UseGuards(ErpReadOnlyGuard)
  @ApiOperation({
    summary: 'Create rep',
    description:
      'Create a new sales rep. Admin/manager only. Blocked when ERP mode is on (salesmen/vans are created in the ERP).',
  })
  @ApiCreatedResponse({ description: 'Rep created' })
  create(@Body() dto: CreateRepDto) {
    return this.reps.create(dto);
  }

  // NOTE: intentionally NOT @UseGuards(ErpReadOnlyGuard) — salesmen stay EDITABLE
  // when ERP mode is on (set/change password, phone, region, quota, active…). The
  // ERP-managed identity (name + code/userNumber) is protected in the service.
  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Update rep',
    description:
      'Update rep fields (incl. login password). Allowed even when ERP mode is on — except name and code (userNumber), which stay ERP-managed. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Updated rep' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRepDto) {
    return this.reps.update(id, dto);
  }


  @Post(':id/activate')
  @ApiOperation({
    summary: 'Activate a frozen salesman',
    description:
      'Unfreeze a salesman with the activation key issued for their code. Idempotent — activating an already-active salesman succeeds and changes nothing.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'The activated salesman' })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivateRepDto,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.reps.activate(id, dto.key, actorId ?? null);
  }

  @Delete(':id')
  @Roles('admin')
  @UseGuards(ErpReadOnlyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete rep', description: 'Soft-delete a rep. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiNoContentResponse({ description: 'Rep soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.reps.softDelete(id);
  }
}
