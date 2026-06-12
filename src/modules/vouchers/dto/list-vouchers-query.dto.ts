import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

/** Optional filters for GET /vouchers. */
export class ListVouchersQueryDto {
  @ApiPropertyOptional({ description: 'Filter by transaction kind (e.g. SALE).' })
  @IsOptional()
  @IsString()
  transKind?: string;

  @ApiPropertyOptional({ description: 'Filter by the user/salesman who created it.' })
  @IsOptional()
  @IsString()
  userCode?: string;

  @ApiPropertyOptional({ description: 'Filter by customer number (for statements).' })
  @IsOptional()
  @IsString()
  customerNumber?: string;

  @ApiPropertyOptional({ description: 'Filter by a store/warehouse touched by any line.' })
  @IsOptional()
  @IsString()
  store?: string;

  @ApiPropertyOptional({ description: 'Inclusive start date (ISO / YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Inclusive end date (ISO / YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
