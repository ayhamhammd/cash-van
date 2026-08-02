import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class AssignRepsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The complete set of reps this user supervises. Replaces any existing assignment; an empty array clears it (and the user then sees nothing).',
    example: ['3f1b0c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'],
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  repIds!: string[];
}
