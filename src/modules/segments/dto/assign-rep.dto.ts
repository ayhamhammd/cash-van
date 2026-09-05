import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Add a rep link, or bulk-assign a segment's members, to this salesman. */
export class AssignRepDto {
  @ApiProperty({ description: 'Salesman (rep) id' })
  @IsUUID()
  repId!: string;
}
