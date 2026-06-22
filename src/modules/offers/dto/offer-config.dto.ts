import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DISCOUNT_MODES,
  PAYMENT_CONDITIONS,
  type CustomerScope,
  type DiscountMode,
  type PaymentCondition,
  type RewardKind,
} from '../offers.types';

const REWARD_KINDS: RewardKind[] = [
  'LINE_PERCENT_DISCOUNT',
  'GIFT',
  'ITEM_PERCENT_DISCOUNT',
];
const CUSTOMER_SCOPES: CustomerScope[] = ['ALL', 'SEGMENT', 'SPECIFIC', 'NEW_ONLY'];

/**
 * Union of all trigger fields across offer types (all optional). Per-type
 * legality (which fields are required) is enforced in OffersService.validateConfig.
 */
export class OfferTriggerDto {
  // ---- PAYMENT_METHOD_DISCOUNT ----
  @ApiPropertyOptional({
    enum: PAYMENT_CONDITIONS,
    description: 'PAYMENT_METHOD_DISCOUNT: CASH matches any non-CREDIT; CREDIT only CREDIT.',
  })
  @IsOptional()
  @IsIn(PAYMENT_CONDITIONS)
  paymentCondition?: PaymentCondition;

  @ApiPropertyOptional({ description: 'PAYMENT_METHOD_DISCOUNT: min order subtotal (fils).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minOrderTotal?: number;

  @ApiPropertyOptional({ description: 'PAYMENT_METHOD_DISCOUNT: min total item count (Σ qty).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minItemCount?: number;

  // ---- ITEM_QTY_REWARD ----
  @ApiPropertyOptional({
    type: [String],
    description: 'ITEM_QTY_REWARD: the selected items. Threshold = their combined qty.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  itemNumbers?: string[];
}

export class GiftTierDto {
  @ApiProperty({ description: 'Combined selected-item qty that unlocks this tier.' })
  @IsInt()
  @Min(1)
  minQty!: number;

  @ApiProperty({ description: 'Number of free gift items granted at this tier.' })
  @IsInt()
  @Min(1)
  freeQty!: number;
}

/**
 * Union of all reward fields across offer types (most optional). Per-type
 * legality is enforced in OffersService.validateConfig.
 */
export class OfferRewardDto {
  @ApiProperty({ enum: REWARD_KINDS })
  @IsIn(REWARD_KINDS)
  kind!: RewardKind;

  // ---- percentage rewards (LINE_PERCENT_DISCOUNT, ITEM_PERCENT_DISCOUNT) ----
  @ApiPropertyOptional({ description: 'Base percentage, 0–100.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  basePercent?: number;

  @ApiPropertyOptional({ enum: DISCOUNT_MODES })
  @IsOptional()
  @IsIn(DISCOUNT_MODES)
  mode?: DiscountMode;

  @ApiPropertyOptional({ description: 'DYNAMIC only: fraction of base added per step, e.g. 0.5.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  multiplier?: number;

  @ApiPropertyOptional({ description: 'DYNAMIC only: items per multiplication step, e.g. 6.' })
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

  // ---- ITEM_PERCENT_DISCOUNT ----
  @ApiPropertyOptional({ description: 'ITEM_PERCENT_DISCOUNT: threshold on combined selected-item qty.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  // ---- GIFT ----
  @ApiPropertyOptional({ type: [String], description: 'GIFT: pool the rep picks free items from.' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  giftItems?: string[];

  @ApiPropertyOptional({ type: [GiftTierDto], description: 'GIFT: static tiers {minQty → freeQty}.' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => GiftTierDto)
  tiers?: GiftTierDto[];
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
