import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNumberString,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class CreateItemSwitchDto {
  @ApiProperty()
  @IsString()
  @Length(1, 32)
  itemNumber!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 64)
  barcode!: string;

  @ApiProperty({ minimum: 1, example: 12 })
  @IsInt()
  @Min(1)
  unitQty!: number;

  @ApiProperty({ example: '1.250' })
  @IsNumberString()
  salePrice!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  itemName!: string;

  @ApiProperty({ example: 'CARTON | PIECE | BOX' })
  @IsString()
  @Length(1, 32)
  unitName!: string;
}
