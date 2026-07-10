import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Destination company accounts the rep's boxes empty into on settlement. */
export class SettleTransfersDto {
  @ApiPropertyOptional({ description: 'Destination account for the sales box' })
  @IsOptional()
  @IsUUID()
  salesAccountId?: string;

  @ApiPropertyOptional({ description: 'Destination account for the receipts box' })
  @IsOptional()
  @IsUUID()
  receiptsAccountId?: string;

  @ApiPropertyOptional({ description: 'Destination account for the cheques box' })
  @IsOptional()
  @IsUUID()
  chequesAccountId?: string;
}

export class EndOfDayQueryDto {
  @ApiProperty({ description: 'From date (YYYY-MM-DD)', example: '2026-06-01' })
  @IsDateString()
  from!: string;

  @ApiProperty({ description: 'To date (YYYY-MM-DD, inclusive)', example: '2026-06-30' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ description: 'Limit to one salesman (rep id)' })
  @IsOptional()
  @IsUUID()
  repId?: string;
}

export class SettleEndOfDayDto {
  @ApiProperty({ description: 'Salesman (rep id) being settled' })
  @IsUUID()
  repId!: string;

  @ApiProperty({ description: 'Period start (YYYY-MM-DD)' })
  @IsDateString()
  from!: string;

  @ApiProperty({ description: 'Period end (YYYY-MM-DD, inclusive)' })
  @IsDateString()
  to!: string;

  @ApiProperty({ description: 'Cash actually handed over by the salesman, in fils' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  receivedFils!: number;

  @ApiPropertyOptional({ description: 'Optional note (reason for shortfall/credit)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'Destination accounts to empty the rep boxes into', type: SettleTransfersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SettleTransfersDto)
  transfers?: SettleTransfersDto;
}

export class SettlementsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ description: 'From date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'To date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class EodLockQueryDto {
  @ApiPropertyOptional({
    description: 'Date to check lock for (YYYY-MM-DD, defaults to today)',
    example: '2026-06-28',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
