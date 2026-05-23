import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListCollectionsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ enum: ['cash', 'cheque'] })
  @IsOptional()
  @IsIn(['cash', 'cheque'])
  method?: string;

  @ApiPropertyOptional({ enum: ['pending', 'confirmed', 'deposited', 'bounced'] })
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'deposited', 'bounced'])
  status?: string;

  @ApiPropertyOptional({ description: 'collected_at >= (ISO)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'collected_at <= (ISO)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 25;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class ListChequesQuery {
  @ApiPropertyOptional({ enum: ['pending', 'cleared', 'bounced', 'cancelled'] })
  @IsOptional()
  @IsIn(['pending', 'cleared', 'bounced', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ description: 'due_date >= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dueFrom?: string;

  @ApiPropertyOptional({ description: 'due_date <= (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dueTo?: string;
}
