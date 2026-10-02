import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { LoginApprovalsService } from './login-approvals.service';
import { LoginRequestStatus } from './entities/login-request.entity';
import { SettingsService } from '../settings/settings.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

export class SecuritySettingsDto {
  @IsBoolean()
  requireDeviceApproval!: boolean;
}

export class ApproveLoginDto {
  /** Also trust this browser, so this user's next sign-ins from it go straight in. */
  @IsOptional()
  @IsBoolean()
  trust?: boolean;
}

export class RenameDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;
}

export class ListLoginRequestsQuery {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'expired', 'used'])
  status?: LoginRequestStatus;
}

@ApiTags('security')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin')
@Controller({ path: 'security', version: '1' })
export class LoginApprovalsController {
  constructor(
    private readonly approvals: LoginApprovalsService,
    private readonly settings: SettingsService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Sign-in security settings', description: 'Admin only.' })
  async getSettings() {
    return { requireDeviceApproval: await this.settings.requireDeviceApproval() };
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Turn device approval on or off',
    description:
      'When on, a web sign-in from a browser not trusted for that user waits for an administrator. ' +
      'Administrators are exempt; the mobile app is unaffected (it has device binding). Admin only.',
  })
  async setSettings(@Body() dto: SecuritySettingsDto) {
    await this.settings.setRequireDeviceApproval(dto.requireDeviceApproval);
    return { requireDeviceApproval: dto.requireDeviceApproval };
  }

  @Get('login-requests')
  @ApiOperation({ summary: 'Sign-ins waiting for approval (and recent decisions)' })
  @ApiOkResponse({ description: 'Newest first, with the user named' })
  listRequests(@Query() q: ListLoginRequestsQuery) {
    return this.approvals.listRequests(q.status);
  }

  @Post('login-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Let this sign-in through, optionally trusting the browser from now on' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveLoginDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.approvals.approve(id, adminId, dto.trust === true);
  }

  @Post('login-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Refuse this sign-in' })
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('sub') adminId: string) {
    return this.approvals.reject(id, adminId);
  }

  @Get('trusted-devices')
  @ApiOperation({ summary: 'Browsers trusted per user' })
  listTrusted() {
    return this.approvals.listTrusted();
  }

  @Patch('trusted-devices/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Rename a trusted device' })
  rename(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameDeviceDto) {
    return this.approvals.rename(id, dto.label);
  }

  @Delete('trusted-devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Stop trusting a device; its next sign-in asks again' })
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.approvals.revoke(id);
  }
}
