import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class SegmentStatsQuery {
  @ApiProperty({ description: 'Inclusive start date (YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ description: 'Inclusive end date (YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}
