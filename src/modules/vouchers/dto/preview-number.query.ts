import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Query for GET /vouchers/next-number. */
export class PreviewVoucherNumberQueryDto {
  @ApiProperty({ example: 'SALE' })
  @IsString()
  @Length(1, 32)
  transKind!: string;

  @ApiProperty({ example: 'MAIN' })
  @IsString()
  @Length(1, 64)
  store!: string;
}
