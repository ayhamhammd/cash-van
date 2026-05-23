import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateInvoiceDto } from './create-invoice.dto';

/** Only valid while the invoice is in 'draft'. repId/customerId are immutable. */
export class UpdateInvoiceDto extends PartialType(
  OmitType(CreateInvoiceDto, ['repId', 'customerId'] as const),
) {}
