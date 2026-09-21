import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

import { CreateVoucherDto } from '../../vouchers/dto/create-voucher.dto';
import { CreateCollectionDto } from '../../collections/dto/create-collection.dto';

/** Mobile idempotency key carried alongside any synced document. */
export class ClientRefDto {
  @ApiPropertyOptional({
    description:
      "The device's local id for this document, minted ONCE at creation and " +
      'never regenerated — not on retry, not after a restart, not after a ' +
      'reinstall. Replays with the same ref return the existing inbox row ' +
      'instead of creating a duplicate. Omitting it means the document cannot ' +
      'be deduplicated; the server assigns a synthetic key and logs a warning.',
  })
  @IsOptional()
  @IsString()
  clientRef?: string;
}

/** Intake body for a voucher: the normal CreateVoucherDto + an optional clientRef. */
export class SyncVoucherDto extends IntersectionType(CreateVoucherDto, ClientRefDto) {}

/** Intake body for a collection. */
export class SyncCollectionDto extends IntersectionType(
  CreateCollectionDto,
  ClientRefDto,
) {}

/** Edit a staged document's raw payload before re-promoting it. */
export class UpdateInboxPayloadDto {
  @ApiProperty({
    description:
      "The full document payload to replace the staged one (e.g. add a RETURN's referenceVoucherNumber). Editing resets the row to pending and clears the error.",
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  payload!: Record<string, unknown>;
}

export class ListInboxQueryDto {
  @ApiPropertyOptional({
    enum: ['pending', 'posted', 'failed', 'accepted', 'rejected', 'dead_letter'],
    description:
      'Stored state. `pending`/`failed` are the original vocabulary and still ' +
      'apply to historical rows.',
  })
  @IsOptional()
  @IsIn(['pending', 'posted', 'failed', 'accepted', 'rejected', 'dead_letter'])
  status?: 'pending' | 'posted' | 'failed' | 'accepted' | 'rejected' | 'dead_letter';

  @ApiPropertyOptional({ enum: ['VOUCHER', 'COLLECTION'] })
  @IsOptional()
  @IsIn(['VOUCHER', 'COLLECTION'])
  type?: 'VOUCHER' | 'COLLECTION';

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * What the app gets back from an intake — the verdict, in the body.
 *
 * The HTTP status is always 202: it answers "did the server take this?", which
 * is a different question from "did it post?". A rejected document used to
 * travel inside a `201 Created`, so a handset keying on the status code
 * recorded it as synced and was free to drop its only copy.
 */
export class SyncVoucherResultDto {
  @ApiProperty({ description: 'Inbox row id.' })
  id!: string;

  @ApiProperty({ description: 'Echoed, so the app can match without trusting order.' })
  clientRef!: string;

  @ApiProperty({
    description:
      'The authoritative number. May differ from the one the app minted, e.g. ' +
      'when that number already exists.',
  })
  voucherNumber!: string;

  @ApiPropertyOptional({ description: "The app's own number, when it supplied one." })
  clientNumber?: string | null;

  @ApiProperty({
    enum: ['accepted', 'posted', 'rejected'],
    description:
      'accepted — staged, not yet in the main tables: KEEP the local copy. ' +
      'posted — in the main tables: the copy may be dropped. ' +
      'rejected — terminal: drop the copy and show the rep, a human must act.',
  })
  status!: 'accepted' | 'posted' | 'rejected';

  @ApiProperty({ description: 'Promotion attempts so far.' })
  attempts!: number;

  @ApiProperty({ description: 'True only while the server still intends to retry.' })
  retryable!: boolean;

  @ApiPropertyOptional() error?: string | null;
}

/** Query for `GET /sync/status` — the refs the handset still holds locally. */
export class SyncStatusQueryDto {
  @ApiProperty({
    description:
      'Comma-separated clientRefs (max 200). A ref MISSING from the reply never ' +
      'reached the server and must be re-posted.',
    example: 'a1b2c3,d4e5f6',
  })
  @IsString()
  clientRefs!: string;
}
