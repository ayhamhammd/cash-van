import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Set/replace the visit schedule for a single outlet. */
export class UpsertJourneyPlanDto {
  @ApiPropertyOptional({
    description:
      "Days of the rep's route cycle the outlet is visited, each 0..cycleDays-1. " +
      'On the default 7-day cycle these are weekdays (0=Sunday … 6=Saturday); on a ' +
      '14-day cycle they run 0..13. The upper bound is checked against the rep’s own ' +
      'cycle, which is why it is not a fixed @Max here.',
    example: [0, 3],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  cycleDays?: number[];

  @ApiPropertyOptional({
    description:
      'Deprecated alias for `cycleDays`, kept so handsets built before route ' +
      'cycles existed keep working. Ignored when `cycleDays` is present.',
    example: [0, 3],
    type: [Number],
    deprecated: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  weekdays?: number[];

  @ApiPropertyOptional({
    description: 'Pause this schedule without deleting it',
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Admin note for the salesman about this outlet trip',
    example: 'Owner only accepts deliveries before noon.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @ApiPropertyOptional({
    description: 'Task the salesman must complete when visiting this outlet',
    example: 'Collect signed return form and photograph the fridge.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  todo?: string | null;

  @ApiPropertyOptional({
    description: 'Manual visit order within a day (ascending)',
    default: 0,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

class BulkJourneyPlanItemDto extends UpsertJourneyPlanDto {
  @ApiProperty({ format: 'uuid', description: 'Outlet (customer) id' })
  @IsUUID()
  customerId!: string;
}

/** Change a rep's route cycle: how long it runs, where it starts, what it's called. */
export class SetRouteCycleDto {
  @ApiPropertyOptional({
    description:
      'Cycle length in days. 7 is the classic week; 14 means an outlet on day 3 ' +
      'is visited once a fortnight. Omit to leave unchanged.',
    minimum: 1,
    maximum: 100,
    example: 14,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  cycleDays?: number;

  @ApiPropertyOptional({
    description:
      'YYYY-MM-DD date that counts as day 0. Changing it shifts every outlet in ' +
      'the plan to a different real date, so it is normally set once at setup.',
    example: '2026-01-04',
  })
  @IsOptional()
  @IsDateString()
  anchorDate?: string;

  @ApiPropertyOptional({
    description: 'Label for the cycle. Null/omitted ⇒ the UI shows "N days".',
    example: 'Fortnightly north',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string | null;

  @ApiPropertyOptional({
    description:
      'Required to shrink a cycle when outlets are scheduled beyond the new ' +
      'last day. Without it the change is refused and those outlets are listed, ' +
      'because a visit that quietly stops happening is not noticed for weeks.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Replace a rep's entire journey plan in one call (entries not listed are removed). */
export class BulkSetJourneyPlanDto {
  @ApiProperty({ type: [BulkJourneyPlanItemDto], description: 'Full set of outlet schedules for the rep' })
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => BulkJourneyPlanItemDto)
  entries!: BulkJourneyPlanItemDto[];
}
