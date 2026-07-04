import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { ChequeInputDto } from './create-collection.dto';

/** Edit a pending collection. All fields optional; only sent fields change. */
export class UpdateCollectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Linked sale invoice; null clears it' })
  @IsOptional()
  @IsUUID()
  invoiceId?: string | null;

  @ApiPropertyOptional({ description: 'Amount in fils', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @ApiPropertyOptional({ enum: ['cash', 'cheque'] })
  @IsOptional()
  @IsIn(['cash', 'cheque'])
  method?: 'cash' | 'cheque';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD or ISO' })
  @IsOptional()
  @IsDateString()
  collectedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;

  @ApiPropertyOptional({ type: [ChequeInputDto], description: 'Replaces the cheque set when provided.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ChequeInputDto)
  cheques?: ChequeInputDto[];
}
