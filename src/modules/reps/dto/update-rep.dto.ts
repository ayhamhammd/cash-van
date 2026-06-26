import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

import { CreateRepDto } from './create-rep.dto';

export class UpdateRepDto extends PartialType(CreateRepDto) {
  /**
   * New login password for the salesman. When provided, it's set on the rep's
   * linked dashboard/app user (bcrypt-hashed). Allowed even when ERP mode is on.
   */
  @ApiPropertyOptional({ description: 'New login password (min 6 chars).' })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}
