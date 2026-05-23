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

import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('vendors')
@ApiBearerAuth()
@Controller({ path: 'vendors', version: '1' })
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Post()
  @ApiOperation({ summary: 'Create vendor', description: 'Create a supplier/vendor record.' })
  @ApiCreatedResponse({ description: 'Vendor created' })
  create(@Body() dto: CreateVendorDto) {
    return this.vendorsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List vendors', description: 'Paginated vendor list.' })
  @ApiOkResponse({ description: 'Paginated vendor list' })
  list(@Query() query: PaginationDto) {
    return this.vendorsService.paginate(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get vendor', description: 'Fetch a single vendor by id.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Vendor id' })
  @ApiOkResponse({ description: 'The vendor' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.vendorsService.findOneOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update vendor', description: 'Update a vendor record.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Vendor id' })
  @ApiOkResponse({ description: 'Updated vendor' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVendorDto,
  ) {
    return this.vendorsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete vendor', description: 'Soft-delete a vendor.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Vendor id' })
  @ApiNoContentResponse({ description: 'Vendor soft-deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.vendorsService.remove(id);
  }
}
