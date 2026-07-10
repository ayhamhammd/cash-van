import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class UpdateCashAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ description: 'Linked ERP chart-of-accounts id (null to unlink)' })
  @IsOptional()
  @IsString()
  erpAccountId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  erpAccountCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
