import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ActivateRepDto {
  @ApiProperty({
    description:
      "The activation key issued for this salesman's code. Case, spaces and dashes are all forgiven — it gets read down a phone line and typed on a tablet.",
    example: 'K7Q2-9WMB-3XTC-5RJD',
  })
  @IsString()
  // Bounded, not exact: the canonical key is 19 characters with dashes and 16
  // without, and both must be accepted. The real check is the HMAC comparison.
  @MinLength(16)
  @MaxLength(64)
  key!: string;
}
