import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreditNoteLineInputDto {
  @ApiProperty({ description: 'route_stops not — original invoice_lines.id (bigint string)' })
  @IsString()
  invoiceLineId!: string;

  @ApiProperty({ minimum: 0.001 })
  @IsNumber()
  @Min(0.001)
  returnQuantity!: number;
}

export class CreateCreditNoteDto {
  @ApiProperty()
  @IsUUID()
  originalInvoiceId!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 500)
  reason!: string;

  @ApiProperty({ type: [CreditNoteLineInputDto], maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineInputDto)
  lines!: CreditNoteLineInputDto[];
}
