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

import { CategoriesService } from './categories.service';
import {
  CreateProductCategoryDto,
  UpdateProductCategoryDto,
} from './dto/category.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';

@ApiTags('product-categories')
@ApiBearerAuth()
@UseGuards(RolesGuard, ErpReadOnlyGuard)
@Controller({ path: 'product-categories', version: '1' })
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'Category tree',
    description: 'Return root categories with their nested children.',
  })
  @ApiOkResponse({ description: 'Nested category tree' })
  tree() {
    return this.categories.tree();
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create category', description: 'Create a product category. Admin/manager only.' })
  @ApiCreatedResponse({ description: 'Category created' })
  create(@Body() dto: CreateProductCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Update category', description: 'Update a category. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category id' })
  @ApiOkResponse({ description: 'Updated category' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete category', description: 'Soft-delete a category. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category id' })
  @ApiNoContentResponse({ description: 'Category soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.categories.softDelete(id);
  }
}
