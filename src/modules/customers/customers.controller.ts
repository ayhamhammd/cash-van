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
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { CustomersService } from './customers.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { SeedLocationDto } from './dto/seed-location.dto';
import { ListCustomersQuery } from './dto/list-customers.query';
import { ListVisitsQuery } from './dto/list-visits.query';
import { CreateVisitDto } from './dto/create-visit.dto';
import { ReassignCustomerDto } from './dto/reassign-customer.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ErpReadOnlyGuard } from '../../common/guards/erp-readonly.guard';

@ApiTags('customers')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'List customers',
    description:
      'List customers with optional filters (q, segment, churnRisk, region, rep) and pagination. ' +
      'Field reps (salesmen) are automatically scoped to their own assigned customers.',
  })
  @ApiOkResponse({ description: 'Paginated customer list' })
  list(@Query() query: ListCustomersQuery, @CurrentUser() user: AuthenticatedUser) {
    // A field rep (repId present on the JWT) only ever sees the customers
    // assigned to them — force the rep scope regardless of any repId/unassigned
    // the client sent. Admins/managers (repId null) keep the full, filterable list.
    if (user?.repId) {
      query.repId = user.repId;
      query.unassigned = false;
    }
    return this.customers.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer', description: 'Fetch a single customer by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiOkResponse({ description: 'The customer' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOneOrThrow(id);
  }

  @Get(':id/insights')
  @ApiOperation({
    summary: 'Customer AI insights',
    description: 'AI panel for a customer: profile + recent visits + summaries.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiOkResponse({ description: 'Customer AI profile, recent visits and summaries' })
  insights(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.insights(id);
  }

  // Allowed even when ERP mode is on — like Update below, a new customer saves
  // locally AND pushes to the ERP (erp.customer.created → pushCustomer), so both
  // sides stay in sync. Gated by the canAddCustomer permission (NOT ErpReadOnlyGuard).
  @Post()
  @RequirePermissions('canAddCustomer')
  @ApiOperation({
    summary: 'Create customer',
    description:
      'Create a customer. Allowed even when ERP mode is on — the new customer is mirrored to the ERP. Requires the canAddCustomer permission.',
  })
  @ApiCreatedResponse({ description: 'Customer created' })
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  // NOTE: intentionally NOT @UseGuards(ErpReadOnlyGuard) — unlike other ERP-
  // managed base data, customers stay EDITABLE on VanFlow even when ERP mode is
  // on. The edit saves locally AND pushes to the ERP (erp.customer.updated →
  // PATCH by id-map erpId), so both sides stay in sync.
  @Patch(':id')
  @RequirePermissions('canEditCustomerCredit')
  @ApiOperation({
    summary: 'Update customer',
    description:
      'Update a customer. Allowed even when ERP mode is on — the change is mirrored to the ERP. Requires the canEditCustomerCredit permission.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiOkResponse({ description: 'Updated customer' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(id, dto);
  }

  @Post(':id/location')
  @ApiOperation({
    summary: 'Seed customer location',
    description:
      "Set a customer's GPS location if it has none yet (seed-once — only fills " +
      'an empty pin, never moves an existing one). Used by location-locked reps ' +
      'to bootstrap a store that has no coordinates. Admins edit/remove via PATCH.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiCreatedResponse({ description: 'The customer (with location if it took effect)' })
  seedLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SeedLocationDto,
  ) {
    return this.customers.seedLocation(id, dto.lat, dto.lng);
  }

  @Post(':id/reassign')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Reassign customer',
    description: 'Reassign a customer to a different rep. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiCreatedResponse({ description: 'Customer reassigned' })
  reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignCustomerDto,
  ) {
    return this.customers.reassign(id, dto.newRepId);
  }

  @Get(':id/visits')
  @ApiOperation({
    summary: 'List customer visits',
    description: 'List recent visits logged for a customer.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiOkResponse({ description: 'Recent visits (optionally within a date range)' })
  listVisits(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListVisitsQuery,
  ) {
    return this.customers.listVisits(id, query);
  }

  @Post(':id/visits')
  @ApiOperation({
    summary: 'Log customer visit',
    description: 'Log a customer visit (mobile check-in).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiCreatedResponse({ description: 'Visit recorded' })
  addVisit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVisitDto,
  ) {
    return this.customers.addVisit(id, dto);
  }

  @Post(':id/refresh-ai')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Refresh AI profile',
    description: 'Queue an AI-profile refresh for a customer. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiCreatedResponse({ description: 'AI refresh queued' })
  refreshAi(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.requestAiRefresh(id);
  }

  @Post('import')
  @Roles('admin', 'manager')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Bulk import customers',
    description:
      'Bulk CSV import. Columns: number,name,address,phone,category. Admin/manager only.',
  })
  @ApiCreatedResponse({ description: 'Import summary (created/updated/skipped counts)' })
  import(@UploadedFile() file: Express.Multer.File) {
    return this.customers.importCsv(file.buffer);
  }

  @Get(':id/attachments')
  @ApiOperation({
    summary: 'List customer attachments',
    description: 'Files (documents, scans, data sheets) attached to a customer.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiOkResponse({ description: 'Attachment metadata, newest first' })
  listAttachments(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.listAttachments(id);
  }

  @Post(':id/attachments')
  @Roles('admin', 'manager')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload customer attachment',
    description:
      'Attach a file (PDF, image, CSV/Excel, Word — max 10 MB) to a customer. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiCreatedResponse({ description: 'The stored attachment' })
  addAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') userId: string,
  ) {
    return this.customers.addAttachment(id, file, userId ?? null);
  }

  @Get(':id/attachments/:attachmentId/download')
  @ApiOperation({
    summary: 'Download a customer attachment',
    description: 'Streams the stored file bytes (authenticated).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiParam({ name: 'attachmentId', format: 'uuid', description: 'Attachment id' })
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { attachment, buffer } = await this.customers.getAttachmentFile(
      id,
      attachmentId,
    );
    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(
        attachment.originalName,
      )}"`,
    });
    return new StreamableFile(buffer);
  }

  @Delete(':id/attachments/:attachmentId')
  @Roles('admin', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete customer attachment',
    description: 'Remove an attached file (bytes + record). Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiParam({ name: 'attachmentId', format: 'uuid', description: 'Attachment id' })
  @ApiNoContentResponse({ description: 'Attachment deleted' })
  removeAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.customers.removeAttachment(id, attachmentId);
  }

  @Delete(':id')
  @UseGuards(ErpReadOnlyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete customer', description: 'Soft-delete a customer.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiNoContentResponse({ description: 'Customer soft-deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(id);
  }
}
