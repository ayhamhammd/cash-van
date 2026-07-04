import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { OFFER_TYPES, type OfferType } from '../offers.types';
import {
  OfferEligibilityDto,
  OfferRewardDto,
  OfferTriggerDto,
} from './offer-config.dto';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateOfferDto {
  @ApiProperty({ example: 'Cash payment — 5% off each line' })
  @IsString()
  @Length(1, 160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @ApiProperty({ enum: OFFER_TYPES })
  @IsIn(OFFER_TYPES)
  type!: OfferType;

  @ApiProperty({ type: OfferTriggerDto, description: 'Type-specific trigger (payment condition + optional minimums).' })
  @IsObject()
  @ValidateNested()
  @Type(() => OfferTriggerDto)
  trigger!: OfferTriggerDto;

  @ApiProperty({ type: OfferRewardDto })
  @IsObject()
  @ValidateNested()
  @Type(() => OfferRewardDto)
  reward!: OfferRewardDto;

  @ApiPropertyOptional({ type: OfferEligibilityDto, default: { customerScope: 'ALL' } })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OfferEligibilityDto)
  eligibility?: OfferEligibilityDto;

  // ---- schedule ----
  @ApiPropertyOptional({ description: 'ISO datetime. Before this the offer is "scheduled".' })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({ description: 'ISO datetime. After this the offer is "expired".' })
  @IsOptional()
  @IsDateString()
  validTo?: string;

  @ApiPropertyOptional({ type: [Number], description: 'Weekdays 0=Sun … 6=Sat. Omit = every day.' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @ApiPropertyOptional({ example: '08:00', description: 'Inclusive start of daily window (HH:mm).' })
  @IsOptional()
  @Matches(TIME_RE, { message: 'timeFrom must be HH:mm' })
  timeFrom?: string;

  @ApiPropertyOptional({ example: '20:00', description: 'Inclusive end of daily window (HH:mm).' })
  @IsOptional()
  @Matches(TIME_RE, { message: 'timeTo must be HH:mm' })
  timeTo?: string;

  // ---- limits ----
  @ApiPropertyOptional({ description: 'Cap on total redemptions across all customers.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  totalRedemptionLimit?: number;

  @ApiPropertyOptional({ description: 'Cap on redemptions per customer.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  perCustomerLimit?: number;

  // ---- ranking / stacking ----
  @ApiPropertyOptional({ default: 0, description: 'Higher wins first when offers compete.' })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ default: false, description: 'May combine with other stackable offers.' })
  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
