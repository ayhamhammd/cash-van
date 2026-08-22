import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

/** Query for the per-rep commission report: one salesman, a date range. */
export class RepCommissionQueryDto {
  @ApiProperty({ format: 'uuid', description: 'The salesman to report on' })
  @IsUUID()
  repId!: string;

  @ApiProperty({ description: 'Inclusive start date (YYYY-MM-DD)', example: '2026-08-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    description: 'Inclusive end date (YYYY-MM-DD) — the whole day is included',
    example: '2026-08-31',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}
