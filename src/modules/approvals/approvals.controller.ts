import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApprovalsService } from './approvals.service';
import {
  CreateApprovalDto,
  ListApprovalsQueryDto,
  RejectApprovalDto,
} from './dto/approvals.dto';
import { ApprovalStatus } from './entities/approval-request.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('approvals')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller({ path: 'approvals', version: '1' })
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  @ApiOperation({
    summary: 'File an approval request',
    description:
      'Salesman submits a gated action (return / discount / price override) with the full proposed voucher payload. Managers are notified in realtime.',
  })
  @ApiCreatedResponse({ description: 'The pending request' })
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateApprovalDto) {
    return this.approvals.create(userId, dto);
  }

  @Get()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Approvals queue', description: 'Filter by status/type. Newest first.' })
  @ApiOkResponse({ description: '{ items, total }' })
  list(@Query() q: ListApprovalsQueryDto) {
    return this.approvals.list(q);
  }

  @Get('mine')
  @ApiOperation({
    summary: 'My requests',
    description: "The calling salesman's own requests (newest 50). Mobile polls this for decisions.",
  })
  @ApiOkResponse({ description: 'ApprovalRequest[]' })
  mine(
    @CurrentUser('sub') userId: string,
    @Query('status') status?: ApprovalStatus,
  ) {
    return this.approvals.mine(userId, status);
  }

  @Get(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Request detail (payload included)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'ApprovalRequest' })
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.findOneOrThrow(id);
  }

  @Post(':id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Approve & execute',
    description:
      'Creates/posts the proposed voucher from the stored payload, records the voucher number, and notifies the salesman.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Decided request (resultVoucher set on success)' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') reviewerId: string,
  ) {
    return this.approvals.approve(id, reviewerId);
  }

  @Post(':id/reject')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Reject with a reason (shown verbatim to the salesman)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Decided request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') reviewerId: string,
    @Body() dto: RejectApprovalDto,
  ) {
    return this.approvals.reject(id, reviewerId, dto.reason);
  }
}
