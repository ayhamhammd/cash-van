import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import type { CashAccountKind } from '../entities/cash-account.entity';

const KINDS: CashAccountKind[] = ['REP_SALES', 'REP_RECEIPTS', 'REP_CHEQUES', 'COMPANY'];

export class CreateCashAccountDto {
  @ApiProperty({ description: 'Box kind', enum: KINDS })
  @IsIn(KINDS)
  kind!: CashAccountKind;

  @ApiProperty({ description: 'Display name' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ description: 'Unique code; auto-generated when omitted' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  code?: string;

  @ApiPropertyOptional({ description: 'Owner rep; omit for a shared/combined or company account' })
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ description: 'Linked ERP chart-of-accounts id (GL mapping)' })
  @IsOptional()
  @IsString()
  erpAccountId?: string;

  @ApiPropertyOptional({ description: 'ERP account code/name snapshot (display)' })
  @IsOptional()
  @IsString()
  erpAccountCode?: string;
}
