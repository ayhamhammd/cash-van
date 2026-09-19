import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

export class BatchDepositDto {
  @ApiProperty({ type: [String], description: 'Collection UUIDs to mark deposited' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  collectionIds!: string[];
}

export class ReconcileChequeDto {
  @ApiProperty({ description: 'Confirmed amount in fils', minimum: 1 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 300)
  amountWords?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 128)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 64)
  chequeNumber?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

/**
 * Complete a cheque's identity after the fact.
 *
 * The handsets send a cheque number but no due date, and the ERP refuses a
 * CHECK receipt without both — so a cheque collected in the field is recorded
 * here and then rejected on the way out. This is how the office supplies what
 * is missing, off the physical cheque, and gets the receipt moving again.
 *
 * Distinct from ReconcileChequeDto, which settles an amount-in-words dispute
 * and stamps the cheque as manager-reviewed. Supplying a due date is neither:
 * nothing is in dispute and nothing has been reviewed.
 */
export class UpdateChequeDetailsDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD — the date written on the cheque' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  chequeNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 128)
  bankName?: string;
}
