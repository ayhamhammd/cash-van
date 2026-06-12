import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ApprovalStatus, ApprovalType } from '../entities/approval-request.entity';

export const APPROVAL_TYPES: ApprovalType[] = [
  'RETURN_VOUCHER',
  'VOUCHER_DISCOUNT',
  'PRICE_OVERRIDE',
];

export class CreateApprovalDto {
  @ApiProperty({ enum: APPROVAL_TYPES })
  @IsIn(APPROVAL_TYPES)
  type!: ApprovalType;

  @ApiProperty({
    description: 'The proposed CreateVoucherDto, exactly as it would be posted.',
    type: Object,
  })
  @IsObject()
  @IsNotEmpty()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Customer the action concerns.' })
  @IsOptional()
  @IsString()
  customerNumber?: string;

  @ApiPropertyOptional({ description: "Salesman's justification.", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectApprovalDto {
  @ApiProperty({ description: 'Reason shown verbatim to the salesman.', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListApprovalsQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected', 'cancelled'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'cancelled'])
  status?: ApprovalStatus;

  @ApiPropertyOptional({ enum: APPROVAL_TYPES })
  @IsOptional()
  @IsIn(APPROVAL_TYPES)
  type?: ApprovalType;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
