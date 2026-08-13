import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import { RETURN_STRATEGIES, type ReturnStrategy } from '../strategies';

export class ReturnRequestLineDto {
  @ApiProperty({ example: 'ACT-GEL-500' })
  @IsString()
  itemNumber!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The unit sold in. REQUIRED to match correctly when an item sells in more than one unit — a carton return must not draw from a piece line. Omit only for items with no unit rows.',
  })
  @IsOptional()
  @IsUUID()
  itemUnitId?: string;

  @ApiProperty({ example: 3 })
  @IsNumber()
  @IsPositive()
  quantity!: number;

  @ApiPropertyOptional({
    description:
      'What the customer says they paid per unit. Required by CLOSEST_PRICE and ignored by every other strategy.',
  })
  @IsOptional()
  @IsNumber()
  expectedUnitPrice?: number;
}

export class PreviewReturnDto {
  @ApiProperty({ type: [ReturnRequestLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnRequestLineDto)
  lines!: ReturnRequestLineDto[];

  @ApiPropertyOptional({
    enum: RETURN_STRATEGIES,
    default: 'NEWEST_FIRST',
    description:
      'The order an item\'s past sales are walked. Only the order — the walk itself is the same.',
  })
  @IsOptional()
  @IsIn(RETURN_STRATEGIES)
  strategy?: ReturnStrategy;

  @ApiPropertyOptional({
    description:
      'Narrow to one customer. Omitted searches every customer, which is correct for cash sales where the buyer was never identified.',
  })
  @IsOptional()
  @IsString()
  customerNumber?: string;

  @ApiPropertyOptional({ description: "Narrow to one salesman's sales." })
  @IsOptional()
  @IsString()
  userCode?: string;
}

export class ConfirmReturnDto extends PreviewReturnDto {
  @ApiProperty({ description: 'The salesman the return vouchers are raised under.' })
  @IsString()
  confirmUserCode!: string;

  @ApiPropertyOptional({
    description: 'Where the goods physically come back to. Defaults to the voucher rules.',
  })
  @IsOptional()
  @IsString()
  storeNumber?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Post the return vouchers immediately (moves stock, hits the ledger, and queues the ERP push). Left false they are drafts — but note the returnable allowance is reserved either way, so an abandoned draft keeps holding those units.',
  })
  @IsOptional()
  @IsBoolean()
  post?: boolean;
}
