import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  DISCOUNT_MODES,
  PAYMENT_CONDITIONS,
  type CustomerScope,
  type DiscountMode,
  type PaymentCondition,
  type RewardKind,
} from '../offers.types';

const REWARD_KINDS: RewardKind[] = ['LINE_PERCENT_DISCOUNT'];
const CUSTOMER_SCOPES: CustomerScope[] = ['ALL', 'SEGMENT', 'SPECIFIC', 'NEW_ONLY'];

/**
 * Trigger for PAYMENT_METHOD_DISCOUNT. Per-type legality (required fields) is
 * enforced in OffersService.validateConfig().
 */
export class OfferTriggerDto {
  @ApiProperty({
    enum: PAYMENT_CONDITIONS,
    description: 'CASH matches any non-CREDIT payment; CREDIT matches CREDIT only.',
  })
  @IsIn(PAYMENT_CONDITIONS)
  paymentCondition!: PaymentCondition;

  @ApiPropertyOptional({
    description: 'Minimum order subtotal in fils for the offer to apply.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minOrderTotal?: number;

  @ApiPropertyOptional({
    description: 'Minimum total item count (sum of qty) for the offer to apply.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  minItemCount?: number;
}

/**
 * Per-line percentage discount reward (static or dynamic). Amount-off rewards
 * are out of scope in this iteration.
 */
export class OfferRewardDto {
  @ApiProperty({ enum: REWARD_KINDS })
  @IsIn(REWARD_KINDS)
  kind!: RewardKind;

  @ApiProperty({ description: 'Base percentage, 0–100.' })
  @IsNumber()
  @Min(0)
  @Max(100)
  basePercent!: number;

  @ApiProperty({ enum: DISCOUNT_MODES })
  @IsIn(DISCOUNT_MODES)
  mode!: DiscountMode;

  @ApiPropertyOptional({
    description: 'DYNAMIC only: fraction of base added per step, e.g. 0.5.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  multiplier?: number;

  @ApiPropertyOptional({
    description: 'DYNAMIC only: items per multiplication step, e.g. 6.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  itemsPerStep?: number;

  @ApiPropertyOptional({ description: 'DYNAMIC only: cap on effective percent, 0–100.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxPercent?: number;
}

export class OfferEligibilityDto {
  @ApiProperty({ enum: CUSTOMER_SCOPES, default: 'ALL' })
  @IsIn(CUSTOMER_SCOPES)
  customerScope!: CustomerScope;

  @ApiPropertyOptional({ type: [String], description: 'SEGMENT: customer categories.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  segments?: string[];

  @ApiPropertyOptional({ type: [String], description: 'SPECIFIC: customer numbers.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customerNumbers?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  regionIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  repIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  storeNumbers?: string[];
}
