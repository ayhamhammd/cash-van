import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  'ITEM_AMOUNT_DISCOUNT',
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

  // ---- ITEM_PERCENT_DISCOUNT / ITEM_AMOUNT_DISCOUNT ----
  @ApiPropertyOptional({ description: 'ITEM_PERCENT_DISCOUNT/ITEM_AMOUNT_DISCOUNT: threshold on combined selected-item qty.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  // ---- ITEM_AMOUNT_DISCOUNT ----
  @ApiPropertyOptional({ description: 'ITEM_AMOUNT_DISCOUNT: amount off per unit, in fils.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  baseAmountFils?: number;

  @ApiPropertyOptional({ description: 'ITEM_AMOUNT_DISCOUNT DYNAMIC only: cap on the effective per-unit amount, in fils.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxAmountFils?: number;

  // ---- GIFT ----
  @ApiPropertyOptional({ type: [String], description: 'GIFT: pool the rep picks free items from.' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  giftItems?: string[];

  @ApiPropertyOptional({ description: 'GIFT: buy this many of the selected items to earn one step of free gifts.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  itemsPerGift?: number;

  @ApiPropertyOptional({ description: 'GIFT: free gifts granted per step (default 1). E.g. itemsPerGift 10 + giftsPerStep 3 → buy 10 get 3.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  giftsPerStep?: number;

  @ApiPropertyOptional({ description: 'GIFT: optional cap on the number of free gifts.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxFreeQty?: number;
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
