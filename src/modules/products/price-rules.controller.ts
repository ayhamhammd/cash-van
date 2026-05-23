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

import { PriceRulesService } from './price-rules.service';
import { CreatePriceRuleDto, UpdatePriceRuleDto } from './dto/price-rule.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('price-rules')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'price-rules', version: '1' })
export class PriceRulesController {
  constructor(private readonly rules: PriceRulesService) {}

  @Get()
  @ApiOperation({
    summary: 'List price rules',
    description: 'List all discount / special-price rules.',
  })
  @ApiOkResponse({ description: 'Price rule list' })
  list() {
    return this.rules.list();
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create price rule', description: 'Create a price rule. Admin/manager only.' })
  @ApiCreatedResponse({ description: 'Price rule created' })
  create(@Body() dto: CreatePriceRuleDto) {
    return this.rules.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Update price rule', description: 'Update a price rule. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Price rule id' })
  @ApiOkResponse({ description: 'Updated price rule' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceRuleDto) {
    return this.rules.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete price rule', description: 'Soft-delete a price rule. Admin only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Price rule id' })
  @ApiNoContentResponse({ description: 'Price rule soft-deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.rules.softDelete(id);
  }
}
