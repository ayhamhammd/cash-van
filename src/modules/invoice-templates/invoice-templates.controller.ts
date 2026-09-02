import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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

import { InvoiceTemplatesService } from './invoice-templates.service';
import {
  CreateInvoiceTemplateDto,
  ListInvoiceTemplatesQueryDto,
  ResolveInvoiceTemplateQueryDto,
  UpdateInvoiceTemplateDto,
} from './dto/invoice-template.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * Designed print layouts (the "Template Designer"). Reads are open to any
 * authenticated user — the app resolves the layout it prints with. Writes are
 * admin-only.
 */
@ApiTags('invoice-templates')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'invoice-templates', version: '1' })
export class InvoiceTemplatesController {
  constructor(private readonly templates: InvoiceTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'List templates', description: 'Newest first. Optional `branchId` filter.' })
  @ApiOkResponse({ description: 'Templates' })
  list(@Query() q: ListInvoiceTemplatesQueryDto) {
    return this.templates.list(q.branchId);
  }

  @Get('resolve')
  @ApiOperation({
    summary: 'Resolve the template to print with',
    description: 'Branch template → global default → built-in layout (id null).',
  })
  @ApiOkResponse({ description: 'The template to render' })
  resolve(@Query() q: ResolveInvoiceTemplateQueryDto) {
    return this.templates.resolve(q.documentType, q.branchId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get template' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'The template' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.findOne(id);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create template', description: 'Admin only. A global default unsets the previous one.' })
  @ApiCreatedResponse({ description: 'Template created' })
  create(@Body() dto: CreateInvoiceTemplateDto) {
    return this.templates.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'Update template', description: 'Admin only. documentType cannot change.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Updated template' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceTemplateDto) {
    return this.templates.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete template', description: 'Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Template deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.templates.remove(id);
  }
}
