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
