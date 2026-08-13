import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@ApiBearerAuth()
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Bound handsets',
    description:
      'Live bindings, or every binding for one user (`userId`) including ' +
      'released ones — the history of who carried which phone.',
  })
  @ApiOkResponse({ description: 'Device bindings' })
  list(@Query('userId') userId?: string) {
    return userId ? this.devices.listForUser(userId) : this.devices.listLive();
  }

  @Post(':id/release')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Release a handset',
    description:
      'The only way out of a binding: frees the device for another salesman, ' +
      'frees the salesman for another device, and revokes the tracking token ' +
      'so the handset stops reporting. Use it when a phone is lost, broken or ' +
      'reassigned. Idempotent.',
  })
  @ApiOkResponse({ description: 'Released' })
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.devices.release(id, user.sub);
  }
}
