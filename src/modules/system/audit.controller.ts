import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('audit-log')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin')
@Controller({ path: 'audit-log', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Query audit log',
    description: 'Query the audit log with filters (actor, action, entity, date range). Admin only.',
  })
  @ApiOkResponse({ description: 'Matching audit entries' })
  query(@Query() q: AuditQueryDto) {
    return this.audit.query(q);
  }

  @Get(':entity/:entityId')
  @ApiOperation({
    summary: 'Record change history',
    description: 'Full change history for a single record. Admin only.',
  })
  @ApiParam({ name: 'entity', description: 'Entity/table name', example: 'invoices' })
  @ApiParam({ name: 'entityId', description: 'Record id', example: '8f3a...' })
  @ApiOkResponse({ description: 'Ordered change history for the record' })
  forEntity(@Param('entity') entity: string, @Param('entityId') entityId: string) {
    return this.audit.forEntity(entity, entityId);
  }
}
