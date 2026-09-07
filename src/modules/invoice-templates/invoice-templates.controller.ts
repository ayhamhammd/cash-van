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
  BuiltinTemplateParamDto,
  CreateInvoiceTemplateDto,
  DOCUMENT_TYPES,
  ListInvoiceTemplatesQueryDto,
  ResolveAllInvoiceTemplatesQueryDto,
  ResolveInvoiceTemplateQueryDto,
  UpdateInvoiceTemplateDto,
} from './dto/invoice-template.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

/**
 * Designed print layouts (the "Template Designer"). Reads are open to any
 * authenticated user — the dashboard and the salesman's app resolve the layout
 * they print with. Writes are admin-only.
 *
 * The named routes (resolve, resolve-all, builtin) are declared before `:id`
 * so Express does not try to parse them as a template id.
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
    description:
      'Store-pinned template → global default → built-in layout (id null). ' +
      'The store is `branchId` (warehouse id) or `storeNumber` (whNumber); an unknown store falls through to the global chain.',
  })
  @ApiOkResponse({ description: 'The template to render' })
  resolve(@Query() q: ResolveInvoiceTemplateQueryDto) {
    return this.templates.resolve(q.documentType, { branchId: q.branchId, storeNumber: q.storeNumber });
  }

  @Get('resolve-all')
  @ApiOperation({
    summary: 'Resolve every kind at once',
    description:
      'The template to print with for each voucher kind, keyed by documentType, plus a `version` ' +
      '(newest updatedAt among saved templates, or "builtin") a device caches and compares to know when to refresh.',
  })
  @ApiOkResponse({ description: '{ templates: Record<documentType, Template>, version: string }' })
  resolveAll(@Query() q: ResolveAllInvoiceTemplatesQueryDto) {
    return this.templates.resolveAll({ branchId: q.branchId, storeNumber: q.storeNumber });
  }

  @Get('builtin/:documentType')
  @ApiOperation({
    summary: 'Built-in layout for a kind',
    description: 'The compiled-in 80 mm receipt (id null). The designer opens it as "the existing design"; saving creates a new template.',
  })
  @ApiParam({ name: 'documentType', enum: DOCUMENT_TYPES })
  @ApiOkResponse({ description: 'The built-in template' })
  builtin(@Param() p: BuiltinTemplateParamDto) {
    return this.templates.builtin(p.documentType);
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
