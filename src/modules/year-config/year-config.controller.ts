import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
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

import { YearConfigService } from './year-config.service';
import { CreateYearConfigDto } from './dto/create-year-config.dto';
import { UpdateYearConfigDto } from './dto/update-year-config.dto';

@ApiTags('year-config')
@ApiBearerAuth()
@Controller({ path: 'year-config', version: '1' })
export class YearConfigController {
  constructor(private readonly yearConfigService: YearConfigService) {}

  @Post()
  @ApiOperation({ summary: 'Create year config', description: 'Create a fiscal-year configuration entry.' })
  @ApiCreatedResponse({ description: 'Year config created' })
  create(@Body() dto: CreateYearConfigDto) {
    return this.yearConfigService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List year configs', description: 'List all year configuration entries.' })
  @ApiOkResponse({ description: 'Year config list' })
  list() {
    return this.yearConfigService.list();
  }

  @Get('year/:year')
  @ApiOperation({ summary: 'List by year', description: 'List configuration entries for a specific year.' })
  @ApiParam({ name: 'year', description: 'Fiscal year', example: 2026 })
  @ApiOkResponse({ description: 'Config entries for the year' })
  listByYear(@Param('year', ParseIntPipe) year: number) {
    return this.yearConfigService.listByYear(year);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update year config', description: 'Update a year configuration entry.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Year config id' })
  @ApiOkResponse({ description: 'Updated year config' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateYearConfigDto,
  ) {
    return this.yearConfigService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete year config', description: 'Delete a year configuration entry.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Year config id' })
  @ApiNoContentResponse({ description: 'Year config deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.yearConfigService.remove(id);
  }
}
