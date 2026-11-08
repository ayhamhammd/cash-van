import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { REASON_CODES, type ReasonCode } from '../delivery-reasons';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 'false' / false / '0' → false; anything else that is set → true.
 *
 * Reads the RAW value from `obj`: the global pipe's implicit conversion runs
 * first and has already turned the string 'false' into `true`.
 */
const toBool = ({ obj, key }: { obj: Record<string, unknown>; key: string }): unknown => {
  const value = obj[key];
  return value === undefined || value === null || value === ''
    ? undefined
    : !(value === false || value === 'false' || value === '0' || value === 0);
};

// ── dashboard ────────────────────────────────────────────────────────────────

export class ListRunsQuery {
  @ApiPropertyOptional({ example: '2026-11-07', description: 'Runs dated this day (YYYY-MM-DD).' })
  @IsOptional()
  @Matches(YMD, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED'] })
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';
}

export class CreateRunDto {
  @ApiProperty({ format: 'uuid', description: 'The delivery rep driving the run (his code is the ERP salesman code).' })
  @IsUUID()
  repId!: string;

  @ApiPropertyOptional({ description: 'ERP vehicle id (GET deliveries/vehicles).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleErpId?: string;

  @ApiPropertyOptional({ example: '2026-11-07' })
  @IsOptional()
  @Matches(YMD, { message: 'runDate must be YYYY-MM-DD' })
  runDate?: string;

  @ApiProperty({ type: [String], example: ['INV-2026-000123'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  invoiceNumbers!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class PatchRunDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  addInvoiceNumbers?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Mirror stop ids to take off the run.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  removeStopIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Mirror stop ids in the new order.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  order?: string[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  repId?: string;

  @ApiPropertyOptional({ nullable: true, description: 'ERP vehicle id; null takes the vehicle off.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  vehicleErpId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class LoadableInvoicesQuery {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(YMD, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-07' })
  @IsOptional()
  @Matches(YMD, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'TREE mode: customers anywhere under this location.' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'FLAT mode: customers in this area (customers.area_id).' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiPropertyOptional({ description: "The invoice's salesman, by rep code." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  salesmanCode?: string;

  @ApiPropertyOptional({ description: 'Search: invoice number, customer name or number.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ default: true, description: 'false also lists fully paid invoices (flagged paid).' })
  @IsOptional()
  @Transform(toBool)
  unpaidOnly?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

// ── app ──────────────────────────────────────────────────────────────────────

export class DeliveryHistoryQuery {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(YMD, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-07' })
  @IsOptional()
  @Matches(YMD, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ enum: ['LOADED', 'DELIVERED', 'PARTIAL', 'RETURNED'] })
  @IsOptional()
  @IsIn(['LOADED', 'DELIVERED', 'PARTIAL', 'RETURNED'])
  status?: 'LOADED' | 'DELIVERED' | 'PARTIAL' | 'RETURNED';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

/** One line of a result: what was delivered, and why not all of it. */
export class DeliveryLineResultDto {
  @ApiProperty({ description: 'The line (Line.erpInvoiceItemId).' })
  @IsString()
  @Length(1, 100)
  erpInvoiceItemId!: string;

  @ApiProperty({ minimum: 0, description: '0 … invoicedQty; decimals for weight units.' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  deliveredQty!: number;

  @ApiPropertyOptional({ enum: REASON_CODES, description: 'Required when deliveredQty < invoicedQty.' })
  @IsOptional()
  @IsIn(REASON_CODES)
  reasonCode?: ReasonCode;

  @ApiPropertyOptional({ description: 'Required with reason OTHER.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A proof clientRef names its file on disk: letters, digits, dot, dash, underscore. */
const PROOF_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `POST sync/delivery-proofs` — the form fields next to `file`. */
export class SyncDeliveryProofDto {
  @ApiProperty({ description: 'Minted once on the phone for this file; the idempotency key.' })
  @IsString()
  @Matches(PROOF_REF, { message: 'clientRef may hold only letters, digits, ".", "-" and "_" (max 100)' })
  clientRef!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stopId!: string;

  @ApiProperty({ enum: ['PHOTO', 'SIGNATURE'] })
  @IsIn(['PHOTO', 'SIGNATURE'])
  kind!: 'PHOTO' | 'SIGNATURE';

  @ApiPropertyOptional({ example: '2026-11-08T10:41:00+03:00' })
  @IsOptional()
  @IsDateString()
  capturedAt?: string;
}

/** A stop's result: the whole invoice, or line by line (phase 2). */
export class SyncDeliveryDto {
  @ApiProperty({
    description:
      'Minted ONCE on the phone for this result and never regenerated. The ' +
      'idempotency key here and the externalId on the ERP.',
  })
  @IsString()
  @Length(1, 100)
  clientRef!: string;

  @ApiProperty({ format: 'uuid', description: 'The mirror stop id (Stop.id).' })
  @IsUUID()
  stopId!: string;

  @ApiProperty({
    enum: ['DELIVERED', 'PARTIAL', 'RETURNED'],
    description: 'Must agree with the lines: all in full → DELIVERED, all 0 → RETURNED, else PARTIAL.',
  })
  @IsIn(['DELIVERED', 'PARTIAL', 'RETURNED'])
  outcome!: 'DELIVERED' | 'PARTIAL' | 'RETURNED';

  @ApiPropertyOptional({
    type: [DeliveryLineResultDto],
    description: 'Lines left out were delivered in full; RETURNED with no lines delivered nothing.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DeliveryLineResultDto)
  lines?: DeliveryLineResultDto[];

  @ApiPropertyOptional({ type: [String], description: 'clientRefs of proofs already uploaded for this stop.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  proofRefs?: string[];

  @ApiProperty({ example: '2026-11-08T10:42:00+03:00' })
  @IsDateString()
  deliveredAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signedByName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
