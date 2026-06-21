import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { OFFER_TYPES, type OfferType } from '../offers.types';

export type OfferStatusFilter = 'all' | 'active' | 'paused' | 'scheduled' | 'expired';
const STATUS_FILTERS: OfferStatusFilter[] = ['all', 'active', 'paused', 'scheduled', 'expired'];

export class ListOffersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(STATUS_FILTERS)
  status?: OfferStatusFilter;

  @ApiPropertyOptional({ enum: OFFER_TYPES })
  @IsOptional()
  @IsIn(OFFER_TYPES)
  type?: OfferType;
}
