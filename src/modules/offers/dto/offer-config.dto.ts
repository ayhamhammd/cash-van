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
  'LINE_AMOUNT_DISCOUNT',
  'TABLE_AMOUNT_DISCOUNT',
  'TABLE_PERCENT_DISCOUNT',
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

  @ApiPropertyOptional({ description: 'PAYMENT_METHOD_DISCOUNT: min total item count (Σ qty) — band floor.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minItemCount?: number;

  @ApiPropertyOptional({ description: 'PAYMENT_METHOD_DISCOUNT: max total item count (Σ qty) — band ceiling. With minItemCount forms an inclusive quantity band.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxItemCount?: number;

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
 * One row of a per-item discount table (TABLE_AMOUNT_DISCOUNT /
 * TABLE_PERCENT_DISCOUNT). Exactly one of `amountFils` / `percent` is meaningful,
 * matching the reward kind — enforced in OffersService.validateConfig.
 */
export class TableEntryDto {
  @ApiProperty({ description: 'The item this row discounts.' })
  @IsString()
  itemNumber!: string;

  @ApiPropertyOptional({ description: 'TABLE_AMOUNT_DISCOUNT: fils off each unit of this item.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  amountFils?: number;

  @ApiPropertyOptional({ description: 'TABLE_PERCENT_DISCOUNT: % off this item, 0–100.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percent?: number;

  @ApiPropertyOptional({ description: 'TABLE_AMOUNT_DISCOUNT: cap the per-unit amount to this % of unit price (0–100).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxPercentOfPrice?: number;
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

  // ---- LINE_AMOUNT_DISCOUNT / ITEM_AMOUNT_DISCOUNT ----
  @ApiPropertyOptional({ description: 'Amount-off rewards: base amount in fils, off each UNIT (× line qty) for both LINE_AMOUNT_DISCOUNT and ITEM_AMOUNT_DISCOUNT.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  baseAmountFils?: number;

  @ApiPropertyOptional({ description: 'Amount-off rewards, DYNAMIC only: cap on the effective amount, in fils (absolute cap).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxAmountFils?: number;

  @ApiPropertyOptional({ description: 'Amount-off rewards: cap the per-unit amount to this % of the line unit price (0–100), applied per line. Combined with maxAmountFils — tighter wins.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxPercentOfPrice?: number;

  // ---- TABLE_AMOUNT_DISCOUNT / TABLE_PERCENT_DISCOUNT (per-item table) ----
  @ApiPropertyOptional({
    type: [TableEntryDto],
    description: 'TABLE_*_DISCOUNT: per-item discount rows. Only listed items are discounted.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => TableEntryDto)
  entries?: TableEntryDto[];

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
