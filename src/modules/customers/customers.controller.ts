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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQuery } from './dto/list-customers.query';
import { CreateVisitDto } from './dto/create-visit.dto';
import { ReassignCustomerDto } from './dto/reassign-customer.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

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
      'List customers with optional filters (q, segment, churnRisk, region, rep) and pagination.',
  })
  @ApiOkResponse({ description: 'Paginated customer list' })
  list(@Query() query: ListCustomersQuery) {
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

  @Post()
  @RequirePermissions('canAddCustomer')
  @ApiOperation({
    summary: 'Create customer',
    description: 'Create a customer. Requires the canAddCustomer permission.',
  })
  @ApiCreatedResponse({ description: 'Customer created' })
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('canEditCustomerCredit')
  @ApiOperation({
    summary: 'Update customer',
    description: 'Update a customer. Requires the canEditCustomerCredit permission.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiOkResponse({ description: 'Updated customer' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(id, dto);
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
  @ApiOkResponse({ description: 'Recent visits' })
  listVisits(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.listVisits(id);
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete customer', description: 'Soft-delete a customer.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Customer id' })
  @ApiNoContentResponse({ description: 'Customer soft-deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(id);
  }
}
