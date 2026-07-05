import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

/** Create/update a dashboard-authored (local) customer contract price. */
export class UpsertCustomerPriceDto {
  @ApiProperty({ description: 'Customer id (customers.id).' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ description: 'Product id (item_cart.id).' })
  @IsUUID()
  itemId!: string;

  @ApiProperty({ description: 'Contract unit price in fils (integer).', example: 9500 })
  @IsInt()
  @Min(0)
  unitPrice!: number;
}
