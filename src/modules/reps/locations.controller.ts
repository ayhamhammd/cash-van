import {
  Body,
  Controller,
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
import {
  BulkRecordLocationDto,
  RecordLocationDto,
} from './dto/record-location.dto';
import { ListLocationsQuery } from './dto/list-locations.query';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('reps-locations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reps', version: '1' })
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post(':id/location')
  @ApiOperation({
    summary: 'Record GPS ping',
    description: 'Record a single GPS ping for a rep (mobile foreground tracking).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Ping recorded' })
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordLocationDto,
  ) {
    return this.locations.record(id, dto);
  }

  @Post(':id/location/bulk')
  @ApiOperation({
    summary: 'Bulk record GPS pings',
    description:
      'Bulk-record GPS pings collected while offline (mobile offline-flush). Up to 500 points per request.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiCreatedResponse({ description: 'Pings recorded (count returned)' })
  recordBulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkRecordLocationDto,
  ) {
    return this.locations.recordBulk(id, dto);
  }

  @Get('locations/latest')
  @ApiOperation({
    summary: 'Latest ping per rep',
    description:
      'Latest GPS ping for each active rep (last-24h window). Powers the Live Map.',
  })
  @ApiOkResponse({ description: 'Latest ping per active rep' })
  latest() {
    return this.locations.latestPerRep();
  }

  @Get(':id/locations')
  @ApiOperation({
    summary: 'Replay GPS trail',
    description: "Replay a rep's GPS trail within a time window.",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Ordered list of pings in the window' })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationsQuery,
  ) {
    return this.locations.list(id, query);
  }

  @Get(':id/locations.geojson')
  @ApiOperation({
    summary: 'GPS trail as GeoJSON',
    description:
      "GeoJSON FeatureCollection (LineString) export of a rep's trail in a window.",
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'GeoJSON FeatureCollection' })
  geojson(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLocationsQuery,
  ) {
    return this.locations.toGeoJsonLineString(id, query);
  }
}
