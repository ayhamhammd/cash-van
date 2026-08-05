import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PERSONAS } from '../personas';

export class ChatDto {
  @ApiProperty({
    description: 'Natural-language report request / question.',
    example: 'Top 10 customers by sales this month as an excel file',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt!: string;

  @ApiPropertyOptional({
    description:
      "Existing conversation id to continue (returned in the previous turn's `done` event). Omit to start a new thread.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({
    description:
      'Which expert answers: analyst (default), admin (cash decisions), ' +
      'auditor (finds problems), sales (route growth). Changes the framing and ' +
      'which tools are offered. All four are read-only.',
    enum: PERSONAS,
  })
  @IsOptional()
  @IsIn(PERSONAS)
  persona?: string;
}
