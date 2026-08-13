import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { StockRequestStatus } from '../entities/stock-request.entity';

export const STOCK_REQUEST_STATUSES: StockRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'received',
];

export class CreateStockRequestLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  itemNumber!: string;

  @ApiPropertyOptional({
    description:
      "The variant unit's stock pool, or '' for the item's base pieces. Defaults to ''.",
  })
  @IsOptional()
  @IsString()
  stockUnitCode?: string;

  @ApiProperty({ description: 'Quantity in the chosen unit.', minimum: 0.001 })
  @IsNumber()
  @Min(0.001)
  qtyOfUnit!: number;

  @ApiPropertyOptional({
    description:
      'Pieces per chosen unit. Defaults to 1. Sent by the app so the figure the ' +
      'salesman saw is the figure recorded, even if the item is re-configured later.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  unitBaseQty?: number;

  @ApiPropertyOptional({
    description:
      'The item_units row picked, when a unit was picked. Required for a variant ' +
      'unit that owns its own stock pool — without it the goods are received into ' +
      "the item's base pool instead.",
  })
  @IsOptional()
  @IsUUID()
  itemUnitId?: string;

  @ApiPropertyOptional({ description: 'Unit display name snapshot.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  unitName?: string;
}

export class CreateStockRequestDto {
  @ApiProperty({ type: [CreateStockRequestLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateStockRequestLineDto)
  items!: CreateStockRequestLineDto[];

  @ApiPropertyOptional({ description: "Salesman's justification.", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApproveStockRequestLineDto {
  @ApiProperty({ description: 'stock_request_items.id' })
  @IsUUID()
  id!: string;

  @ApiProperty({
    description: 'Granted quantity in POOL units. 0 refuses this line only.',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  approvedBaseQty!: number;
}

export class ApproveStockRequestDto {
  @ApiProperty({ description: 'Warehouse the goods leave (warehouses.wh_number).' })
  @IsString()
  @IsNotEmpty()
  sourceStoreNumber!: string;

  @ApiPropertyOptional({
    description:
      'Per-line granted quantities. Lines left out are granted in full — the ' +
      'common case is approving exactly what was asked for.',
    type: [ApproveStockRequestLineDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApproveStockRequestLineDto)
  lines?: ApproveStockRequestLineDto[];

  @ApiPropertyOptional({ description: 'Note shown to the salesman.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectStockRequestDto {
  @ApiProperty({ description: 'Reason shown verbatim to the salesman.', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class AttachTransferDto {
  @ApiProperty({ description: 'The TRANSFER voucher number that fulfilled this request.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  voucherNumber!: string;
}

export class ListStockRequestsQueryDto {
  @ApiPropertyOptional({ enum: STOCK_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(STOCK_REQUEST_STATUSES)
  status?: StockRequestStatus;

  @ApiPropertyOptional({ description: 'Limit to one salesman.' })
  @IsOptional()
  @IsUUID()
  repId?: string;

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
