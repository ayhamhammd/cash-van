import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { LocationsService } from './locations.service';
import { RepStatusService } from './rep-status.service';
import {
  BulkRecordLocationDto,
  RecordLocationDto,
} from './dto/record-location.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { ListLocationsQuery } from './dto/list-locations.query';
import { TrackingSummaryQuery } from './dto/tracking-summary.query';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RepScopeService } from '../users/rep-scope.service';
import { AllowTrackingToken } from '../../common/decorators/tracking-token.decorator';

@ApiTags('reps-locations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reps', version: '1' })
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly repStatus: RepStatusService,
    private readonly repScope: RepScopeService,
  ) {}

  @Post(':id/heartbeat')
  @AllowTrackingToken()
  @ApiOperation({
    summary: 'Liveness heartbeat',
    description:
      'Lightweight rep liveness ping (~60s cadence). Reports GPS-enabled and app state so the server can detect disconnections.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Heartbeat recorded' })
  heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HeartbeatDto,
    @CurrentUser('repId') callerRepId: string | null,
  ) {
    // A rep may only heartbeat as themselves. Admins/managers (repId null) pass.
    if (callerRepId && callerRepId !== id) {
      throw new ForbiddenException({
        message: 'Heartbeat must target your own rep id',
        code: 'forbidden_rep',
      });
    }
    return this.repStatus.heartbeat(id, dto);
  }

  @Post(':id/location')
  @AllowTrackingToken()
  @ApiOperation({
    summary: 'Record GPS ping',
    description:
      'Record a single GPS ping for a rep (mobile foreground tracking). ' +
      'Reachable with the long-lived device tracking token, so a signed-out ' +
      'handset keeps reporting.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Ping recorded' })
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordLocationDto,
    @CurrentUser('repId') callerRepId: string | null,
  ) {
    this.assertOwnRep(id, callerRepId);
    return this.locations.record(id, dto);
  }

  @Post(':id/location/bulk')
  @AllowTrackingToken()
  @ApiOperation({
    summary: 'Bulk record GPS pings',
    description:
      'Bulk-record GPS pings collected while offline (mobile offline-flush). ' +
      'Up to 500 points per request. Reachable with the long-lived device ' +
      'tracking token, so a signed-out handset can still drain its queue.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Pings recorded (count returned)' })
  recordBulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkRecordLocationDto,
    @CurrentUser('repId') callerRepId: string | null,
  ) {
    this.assertOwnRep(id, callerRepId);
    return this.locations.recordBulk(id, dto);
  }

  /**
   * A rep may only report as themselves. Previously only the heartbeat checked
   * this; the location routes now must, because the tracking token reaches them
   * while signed out and a handset must never be able to write another rep's
   * trail. Admins/managers (repId null) still pass, as they do elsewhere.
   */
  private assertOwnRep(targetRepId: string, callerRepId: string | null): void {
    if (callerRepId && callerRepId !== targetRepId) {
      throw new ForbiddenException({
        message: 'Location must be reported for your own rep id',
        code: 'forbidden_rep',
      });
    }
  }

  @Get('locations/latest')
  @ApiOperation({
    summary: 'Latest ping per rep',
    description:
      'Latest GPS ping for each active rep (last-24h window). Powers the Live Map.',
  })
  @ApiOkResponse({ description: 'Latest ping per active rep' })
  async latest(@CurrentUser() user: AuthenticatedUser) {
    return this.locations.latestPerRep(await this.repScope.visibleRepIds(user));
  }

  @Get(':id/locations')
  @ApiOperation({
    summary: 'Replay GPS trail',
    description: "Replay a rep's GPS trail within a time window.",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Ordered list of pings in the window' })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Naming one rep: 403 rather than an empty trail, which would read as
    // "this salesman didn't move today".
    await this.repScope.assertCanSeeRep(user, id);
    return this.locations.list(id, query);
  }

  @Get(':id/visits')
  @ApiOperation({
    summary: "Rep's customer visits in a range",
    description:
      "The rep's customer_visits within [from,to] (defaults last 30d) — the visit markers for the tracking map.",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Ordered list of visits in the window' })
  async visits(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.repScope.assertCanSeeRep(user, id);
    return this.locations.visitsForRep(id, query.from, query.to);
  }

  @Get(':id/sale-points')
  @ApiOperation({
    summary: "Rep's sale locations in a range",
    description:
      "Vouchers the rep saved with a GPS fix, within [from,to] (defaults last 30d) — the sale markers for the tracking map. Vouchers saved without a fix (indoors, location off, raised from the dashboard) are simply absent.",
  })
  @ApiOkResponse({ description: 'Ordered list of located sales in the window' })
  async salePoints(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.repScope.assertCanSeeRep(user, id);
    return this.locations.salePointsForRep(id, query.from, query.to);
  }

  @Get(':id/tracking-summary')
  @ApiOperation({
    summary: 'Per-day / per-month tracking summary',
    description:
      'Distance, active span, points, customers visited and sales per calendar day (or month) for the rep in [from,to].',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Ordered list of tracking buckets' })
  async trackingSummary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TrackingSummaryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.repScope.assertCanSeeRep(user, id);
    return this.locations.trackingSummary(id, query.from, query.to, query.bucket ?? 'day');
  }

  @Get(':id/locations.geojson')
  @ApiOperation({
    summary: 'GPS trail as GeoJSON',
    description:
      "GeoJSON FeatureCollection (LineString) export of a rep's trail in a window.",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'GeoJSON FeatureCollection' })
  async geojson(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Same guard as the trail it exports — otherwise the export is a way around it.
    await this.repScope.assertCanSeeRep(user, id);
    return this.locations.toGeoJsonLineString(id, query);
  }
}
