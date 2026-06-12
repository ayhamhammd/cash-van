import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ListNotificationsQueryDto } from './dto/list-notifications.query';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'My notification inbox',
    description: 'Newest first. `unread=true` filters to unread; response carries the unread count.',
  })
  @ApiOkResponse({ description: '{ items, total, unread }' })
  list(@CurrentUser('sub') userId: string, @Query() q: ListNotificationsQueryDto) {
    return this.notifications.list(
      userId,
      q.unread === true,
      q.offset ?? 0,
      q.limit ?? 25,
    );
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiNoContentResponse()
  async markRead(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notifications.markRead(userId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark all my notifications read' })
  @ApiNoContentResponse()
  async markAllRead(@CurrentUser('sub') userId: string): Promise<void> {
    await this.notifications.markAllRead(userId);
  }
}
