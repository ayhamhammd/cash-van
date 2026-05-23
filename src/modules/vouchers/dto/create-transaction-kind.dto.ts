import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateTransactionKindDto {
  @ApiProperty({ example: 'SALE', description: 'Transaction kind code' })
  @IsString()
  @Length(1, 32)
  transKind!: string;

  @ApiProperty({ example: 'Sales Invoice', description: 'Transaction kind display name' })
  @IsString()
  @Length(1, 200)
  transName!: string;

  @ApiPropertyOptional({
    enum: [-1, 0, 1],
    default: 0,
    description: 'Stock effect sign: -1 reduces, +1 increases, 0 none',
  })
  @IsOptional()
  @IsIn([-1, 0, 1])
  sign?: number;
}
