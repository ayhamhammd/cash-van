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
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  AppliesTo,
  CustomerScope,
  DiscountKind,
  RewardKind,
  SetMatch,
} from '../offers.types';

const DISCOUNT_KINDS: DiscountKind[] = ['PERCENT', 'VALUE'];
const APPLIES_TO: AppliesTo[] = ['TRIGGER_ITEM', 'SET', 'INVOICE'];
const SET_MATCHES: SetMatch[] = ['ANY', 'ALL'];
const REWARD_KINDS: RewardKind[] = ['DISCOUNT', 'FREE_ITEM', 'FREE_ITEM_CHOICE'];
const CUSTOMER_SCOPES: CustomerScope[] = ['ALL', 'SEGMENT', 'SPECIFIC', 'NEW_ONLY'];

/**
 * The trigger/reward/eligibility DTOs declare every field used by any of the 5
 * offer types (all optional). Per-type legality — which fields are required and
 * which reward is allowed — is enforced in OffersService.validateConfig(),
 * which throws BadRequestException with a precise message.
 */
export class OfferTriggerDto {
  @ApiPropertyOptional({ description: 'Trigger item (ITEM_QTY_DISCOUNT, BUY_X_GET_Y_FREE).' })
  @IsOptional()
  @IsString()
  itemNumber?: string;

  @ApiPropertyOptional({ description: 'Min qty of the trigger item (ITEM_QTY_DISCOUNT).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  @ApiPropertyOptional({ description: 'Buy-qty that earns the free item (BUY_X_GET_Y_FREE).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @ApiPropertyOptional({ type: [String], description: 'Item set (BASKET_THRESHOLD, ITEM_SET_THRESHOLD).' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  itemNumbers?: string[];

  @ApiPropertyOptional({ description: 'Min count of set items in cart (BASKET_THRESHOLD).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minItemCount?: number;

  @ApiPropertyOptional({ description: 'Min total qty across set items (ITEM_SET_THRESHOLD).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minTotalQty?: number;

  @ApiPropertyOptional({ enum: SET_MATCHES, description: 'ANY = any set item; ALL = every set item present (ITEM_SET_THRESHOLD).' })
  @IsOptional()
  @IsIn(SET_MATCHES)
  match?: SetMatch;
}

export class FreeItemDto {
  @ApiProperty()
  @IsString()
  itemNumber!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  qty!: number;
}

export class OfferRewardDto {
  @ApiProperty({ enum: REWARD_KINDS })
  @IsIn(REWARD_KINDS)
  kind!: RewardKind;

  @ApiPropertyOptional({ enum: DISCOUNT_KINDS, description: 'DISCOUNT only.' })
  @IsOptional()
  @IsIn(DISCOUNT_KINDS)
  discountType?: DiscountKind;

  @ApiPropertyOptional({ description: 'DISCOUNT only. PERCENT → 0–100; VALUE → fils.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @ApiPropertyOptional({ enum: APPLIES_TO, description: 'DISCOUNT only: where the discount lands.' })
  @IsOptional()
  @IsIn(APPLIES_TO)
  appliesTo?: AppliesTo;

  @ApiPropertyOptional({ type: [FreeItemDto], description: 'FREE_ITEM only.' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => FreeItemDto)
  items?: FreeItemDto[];

  @ApiPropertyOptional({ type: [String], description: 'FREE_ITEM_CHOICE only: items the rep may pick from.' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  choices?: string[];

  @ApiPropertyOptional({ description: 'FREE_ITEM_CHOICE only: how many free items to grant.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;
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
