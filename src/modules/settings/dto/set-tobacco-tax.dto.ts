import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Toggle the tobacco ("smoke") tax feature. A local FlowVan feature flag —
 *  NOT ERP-managed data, so it stays settable even when the ERP integration is on. */
export class SetTobaccoTaxDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}
