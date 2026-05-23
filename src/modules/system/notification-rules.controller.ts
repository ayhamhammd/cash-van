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

import { NotificationRulesService } from './notification-rules.service';
import {
  CreateNotificationRuleDto,
  UpdateNotificationRuleDto,
} from './dto/notification-rule.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('notification-rules')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin', 'manager')
@Controller({ path: 'notification-rules', version: '1' })
export class NotificationRulesController {
  constructor(private readonly rules: NotificationRulesService) {}

  @Get()
  @ApiOperation({ summary: 'List notification rules', description: 'List all notification rules. Admin/manager only.' })
  @ApiOkResponse({ description: 'Notification rule list' })
  list() {
    return this.rules.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create notification rule', description: 'Create a notification rule. Admin/manager only.' })
  @ApiCreatedResponse({ description: 'Rule created' })
  create(@Body() dto: CreateNotificationRuleDto) {
    return this.rules.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update notification rule', description: 'Update a notification rule. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rule id' })
  @ApiOkResponse({ description: 'Updated rule' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNotificationRuleDto) {
    return this.rules.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete notification rule', description: 'Delete a notification rule. Admin/manager only.' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rule id' })
  @ApiNoContentResponse({ description: 'Rule deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.rules.remove(id);
  }

  @Post(':id/test')
  @ApiOperation({
    summary: 'Test notification rule',
    description: 'Fire the rule now with a synthetic payload to verify wiring. Admin/manager only.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Rule id' })
  @ApiCreatedResponse({ description: 'Rule fired with synthetic payload' })
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.test(id);
  }
}
