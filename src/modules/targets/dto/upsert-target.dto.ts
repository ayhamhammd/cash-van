import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

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

  @ApiProperty({ enum: TARGET_METRICS })
  @IsIn(TARGET_METRICS as unknown as string[])
  metric!: string;

  @ApiProperty({ description: 'Target value — fils when metric=AMOUNT, whole units when metric=QTY.' })
  @IsInt()
  @Min(0)
  targetValue!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
