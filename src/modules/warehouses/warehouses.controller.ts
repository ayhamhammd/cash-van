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

import { WarehousesService } from './warehouses.service';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

@ApiTags('warehouses')
@ApiBearerAuth()
@Controller({ path: 'warehouses', version: '1' })
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @Post()
  @ApiOperation({ summary: 'Create warehouse', description: 'Create a warehouse / van stock location.' })
  @ApiCreatedResponse({ description: 'Warehouse created' })
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehousesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List warehouses', description: 'List all warehouses.' })
  @ApiOkResponse({ description: 'Warehouse list' })
  list() {
    return this.warehousesService.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get warehouse', description: 'Fetch a single warehouse by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Warehouse id' })
  @ApiOkResponse({ description: 'The warehouse' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehousesService.findOneOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update warehouse', description: 'Update a warehouse record.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Warehouse id' })
  @ApiOkResponse({ description: 'Updated warehouse' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehousesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete warehouse', description: 'Soft-delete a warehouse.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Warehouse id' })
  @ApiNoContentResponse({ description: 'Warehouse soft-deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehousesService.remove(id);
  }
}
