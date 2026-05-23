import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseFloatPipe,
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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RegionsService } from './regions.service';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { ListRegionsQuery } from './dto/list-regions.query';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('regions')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'regions', version: '1' })
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List regions',
    description: 'List geographic regions (territories) with optional filters.',
  })
  @ApiOkResponse({ description: 'Region list' })
  list(@Query() query: ListRegionsQuery) {
    return this.regions.list(query);
  }

  @Get('containing')
  @ApiOperation({
    summary: 'Region containing a point',
    description:
      'Find the active region whose polygon contains the given (lat, lng). 404 if none.',
  })
  @ApiQuery({ name: 'lat', required: true, description: 'Latitude (WGS84)', example: 31.9539 })
  @ApiQuery({ name: 'lng', required: true, description: 'Longitude (WGS84)', example: 35.9106 })
  @ApiOkResponse({ description: 'The region containing the point' })
  async containing(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
  ) {
    const region = await this.regions.findRegionContaining(lat, lng);
    if (!region) {
      throw new NotFoundException('No active region contains that point');
    }
    return region;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get region', description: 'Fetch a single region by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Region id' })
  @ApiOkResponse({ description: 'The region' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.regions.findOne(id);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Create region',
    description: 'Create a region with a GeoJSON polygon boundary. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Region created' })
  create(@Body() dto: CreateRegionDto) {
    return this.regions.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Update region',
    description: 'Update region fields or boundary. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Region id' })
  @ApiOkResponse({ description: 'Updated region' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRegionDto) {
    return this.regions.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete region', description: 'Soft-delete a region. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Region id' })
  @ApiNoContentResponse({ description: 'Region soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.regions.softDelete(id);
  }
}
