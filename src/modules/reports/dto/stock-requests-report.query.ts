import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { STOCK_REQUEST_STATUSES } from '../../stock-requests/dto/stock-request.dto';
import type { StockRequestStatus } from '../../stock-requests/entities/stock-request.entity';

/** Filters for the stock requests & approvals report. Every one is optional. */
export class StockRequestsReportQueryDto {
  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Requests raised on or after this day (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Requests raised on or before this day (YYYY-MM-DD), inclusive.' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Only this salesman (reps.id).' })
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ description: 'Only requests this user approved or rejected (users.id).' })
  @IsOptional()
  @IsUUID()
  reviewerId?: string;

  @ApiPropertyOptional({
    enum: ['yes', 'no'],
    description:
      "yes = the goods reached the van (status received). no = approved but not received yet. " +
      'Pending, rejected and cancelled requests can never be received, so they are in neither.',
  })
  @IsOptional()
  @IsIn(['yes', 'no'])
  received?: 'yes' | 'no';

  @ApiPropertyOptional({ enum: STOCK_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(STOCK_REQUEST_STATUSES)
  status?: StockRequestStatus;
}
