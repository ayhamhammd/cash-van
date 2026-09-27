import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class VanStockLineDto {
  @ApiProperty({ format: 'uuid', description: 'Product to load/return' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ minimum: 1, example: 24, description: 'Units to load/return' })
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class VanStockMutationDto {
  @ApiProperty({ type: [VanStockLineDto], maxItems: 500 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VanStockLineDto)
  items!: VanStockLineDto[];
}

/** A document the handset still holds unabsorbed stock movements for. */
export class PendingStockDocDto {
  @ApiProperty({ description: "The handset's clientRef for the document (its local id)" })
  @IsString()
  @Length(1, 200)
  ref!: string;

  @ApiPropertyOptional({
    description:
      'The server voucher number, sent only when the number came from the server ' +
      '(an approved request, or a synced document after renumbering).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  number?: string;
}

export class VanStockSnapshotDto {
  @ApiProperty({ type: [PendingStockDocDto], maxItems: 2000 })
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => PendingStockDocDto)
  pending!: PendingStockDocDto[];
}
