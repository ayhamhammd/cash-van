import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export const TARGET_METRICS = ['AMOUNT', 'QTY'] as const;

/** Set (create or replace) a salesman's target for a month. */
export class UpsertTargetDto {
  @ApiProperty()
  @IsUUID()
  repId!: string;

  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 7, description: '1–12' })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  /**
   * The OLD single-target shape. Optional now — a row may carry a sales target,
   * a collection target, commission rates, or any combination.
   */
  @ApiPropertyOptional({ enum: TARGET_METRICS })
  @IsOptional()
  @IsIn(TARGET_METRICS as unknown as string[])
  metric?: string;

  @ApiPropertyOptional({ description: 'Target value — fils when metric=AMOUNT, whole units when metric=QTY.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  targetValue?: number;

  @ApiPropertyOptional({
    description:
      'What this salesman should SELL this month, in fils. Cash and credit share ' +
      'it — a sale is a sale to the person selling it. Omit or null for no target.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  salesTargetFils?: number | null;

  @ApiPropertyOptional({
    description: 'What they should COLLECT this month, in fils. Omit or null for no target.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  collectionTargetFils?: number | null;

  @ApiPropertyOptional({ description: 'Commission on a sale paid for at the time (%). e.g. 3', example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  cashPct?: number;

  @ApiPropertyOptional({ description: 'Commission on a sale left on account (%). e.g. 1.5', example: 1.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  creditPct?: number;

  @ApiPropertyOptional({ description: 'Commission on collecting the money (%). e.g. 1.5', example: 1.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  collectionPct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
