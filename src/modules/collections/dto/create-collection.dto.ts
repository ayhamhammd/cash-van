import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ChequeInputDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 200)
  payee?: string;

  @ApiPropertyOptional({ description: 'Amount in words (Arabic). If set and mismatched, blocks confirm.' })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  amountWords?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  ocrConfidence?: number;

  @ApiPropertyOptional({ description: 'TRUE if numeric amount matches the words', default: true })
  @IsOptional()
  @IsBoolean()
  wordsMatch?: boolean;

  @ApiPropertyOptional({ enum: ['server', 'mlkit_offline'], default: 'server' })
  @IsOptional()
  @IsIn(['server', 'mlkit_offline'])
  scanSource?: 'server' | 'mlkit_offline';

  @ApiPropertyOptional({ description: 'Object-storage path of the scan' })
  @IsOptional()
  @IsString()
  imagePath?: string;
}

export class CreateCollectionDto {
  @ApiProperty()
  @IsUUID()
  repId!: string;

  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @ApiProperty({ description: 'Amount in fils', minimum: 1 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ enum: ['cash', 'cheque'] })
  @IsIn(['cash', 'cheque'])
  method!: 'cash' | 'cheque';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD or ISO; defaults to now()' })
  @IsOptional()
  @IsDateString()
  collectedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;

  @ApiPropertyOptional({ description: 'Required when method=cheque' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChequeInputDto)
  cheque?: ChequeInputDto;
}
