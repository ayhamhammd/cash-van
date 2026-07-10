import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * The three main settlement accounts (ERP chart-of-accounts refs). Picking which ERP
 * account maps to sales/collections is a FlowVan-side choice, so this is NOT ERP-read-only
 * (unlike the generic company-settings PATCH). See docs/SPEC-rep-erp-accounts-settlement.md.
 */
export class UpdateAccountingDto {
  @ApiPropertyOptional({ nullable: true, description: 'ERP account id: rep cash-SALES destination.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(128)
  erpSalesAccountId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255)
  erpSalesAccountCode?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ERP account id: rep cash-COLLECTIONS destination.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(128)
  erpCashCollectionAccountId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255)
  erpCashCollectionAccountCode?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ERP account id: rep CHEQUE collections destination.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(128)
  erpChequeCollectionAccountId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255)
  erpChequeCollectionAccountCode?: string | null;
}
