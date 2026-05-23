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
import { CreateRepDto } from './dto/create-rep.dto';
import { UpdateRepDto } from './dto/update-rep.dto';
import { ListRepsQuery } from './dto/list-reps.query';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('reps')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'reps', version: '1' })
export class RepsController {
  constructor(private readonly reps: RepsService) {}

  @Get()
  @ApiOperation({
    summary: 'List reps',
    description: 'List sales reps with optional filters and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated rep list' })
  list(@Query() query: ListRepsQuery) {
    return this.reps.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get rep', description: 'Fetch a single rep by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'The rep' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.reps.findOne(id);
  }

  @Get(':id/kpis')
  @ApiOperation({
    summary: 'Rep KPIs',
    description: 'KPI snapshot for a rep (sales, visits, collection metrics).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'KPI snapshot' })
  kpis(@Param('id', ParseUUIDPipe) id: string) {
    return this.reps.kpis(id);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Create rep',
    description: 'Create a new sales rep. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Rep created' })
  create(@Body() dto: CreateRepDto) {
    return this.reps.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Update rep',
    description: 'Update rep fields. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiOkResponse({ description: 'Updated rep' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRepDto) {
    return this.reps.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete rep', description: 'Soft-delete a rep. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rep id' })
  @ApiNoContentResponse({ description: 'Rep soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.reps.softDelete(id);
  }
}
