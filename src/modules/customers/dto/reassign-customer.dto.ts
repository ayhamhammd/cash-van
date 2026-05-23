import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ReassignCustomerDto {
  @ApiProperty({ description: 'New rep UUID to own this customer' })
  @IsUUID()
  newRepId!: string;
}
