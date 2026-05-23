import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class RejectInvoiceDto {
  @ApiProperty({ example: 'Exceeds customer credit limit', description: 'Reason for rejection' })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class OverrideInvoiceDto {
  @ApiProperty({ description: 'New invoice-level discount in fils', minimum: 0 })
  @IsInt()
  @Min(0)
  invoiceDiscountAmount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}
