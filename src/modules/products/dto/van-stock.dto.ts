import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
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
