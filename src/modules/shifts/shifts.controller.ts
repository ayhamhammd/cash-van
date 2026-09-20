import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ShiftsService } from './shifts.service';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

/**
 * The rep's working day.
 *
 * Open to any authenticated user rather than admin-gated: the caller is the rep
 * opening their own day, and the dashboard reads the same rows.
 */
@ApiTags('shifts')
@ApiBearerAuth()
@Controller({ path: 'shifts', version: '1' })
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post('open')
  @ApiOperation({
    summary: 'Open a working day',
    description:
      'Carries its own timestamp and coordinates. Pass clientRef for idempotency — ' +
      'a replay is answered 409 with the original shift id, which the handset reads ' +
      'as success. A rep who already has an open shift is also 409, with code ' +
      'shift_already_open: that is a different day, not a retry.',
  })
  @ApiCreatedResponse({ description: 'The open shift' })
  open(@Body() dto: OpenShiftDto) {
    return this.shifts.open(dto);
  }

  @Post(':repId/close')
  @ApiOperation({
    summary: "Close the rep's open day",
    description: 'Refuses a closedAt earlier than the open — a negative day is not a day.',
  })
  @ApiOkResponse({ description: 'The closed shift' })
  close(@Param('repId', ParseUUIDPipe) repId: string, @Body() dto: CloseShiftDto) {
    return this.shifts.close(repId, dto);
  }

  @Get(':repId/current')
  @ApiOperation({
    summary: "The rep's open day, or null",
    description: 'What the handset asks on launch to know whether it is mid-day.',
  })
  @ApiOkResponse({ description: 'The open shift, or null' })
  current(@Param('repId', ParseUUIDPipe) repId: string) {
    return this.shifts.current(repId);
  }

  @Get(':repId')
  @ApiOperation({ summary: "The rep's shifts, most recent first" })
  @ApiOkResponse({ description: 'Shift[]' })
  list(@Param('repId', ParseUUIDPipe) repId: string, @Query('limit') limit?: string) {
    return this.shifts.list(repId, limit ? Number(limit) : undefined);
  }
}
