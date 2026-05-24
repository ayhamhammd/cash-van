import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Set/replace the visit schedule for a single outlet. */
export class UpsertJourneyPlanDto {
  @ApiProperty({
    description:
      'Weekdays the outlet is visited. 0=Sunday … 6=Saturday. Daily = all working days; one day = weekly; two days = twice a week.',
    example: [0, 3],
    type: [Number],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];

  @ApiPropertyOptional({
    description: 'Pause this schedule without deleting it',
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class BulkJourneyPlanItemDto extends UpsertJourneyPlanDto {
  @ApiProperty({ format: 'uuid', description: 'Outlet (customer) id' })
  @IsUUID()
  customerId!: string;
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
