import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The old single-cheque shape: the same fields WITHOUT an amount, because the
 * app that sends it has only the collection's own total.
 */
export class LegacyChequeInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 128)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 64)
  chequeNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 200)
  payee?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @Length(0, 10)
  dueDate?: string;
}

export class ChequeInputDto {
  @ApiProperty({ description: "This cheque's amount in fils", minimum: 1 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 128)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 64)
  chequeNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 200)
  payee?: string;

  @ApiPropertyOptional({ description: 'Amount in words (Arabic). If set and mismatched, blocks confirm.' })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  amountWords?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  ocrConfidence?: number;

  @ApiPropertyOptional({ description: 'TRUE if numeric amount matches the words', default: true })
  @IsOptional()
  @IsBoolean()
  wordsMatch?: boolean;

  @ApiPropertyOptional({ enum: ['server', 'mlkit_offline'], default: 'server' })
  @IsOptional()
  @IsIn(['server', 'mlkit_offline'])
  scanSource?: 'server' | 'mlkit_offline';

  @ApiPropertyOptional({ description: 'Object-storage path of the scan' })
  @IsOptional()
  @IsString()
  imagePath?: string;
}

export class CreateCollectionDto {
  @ApiProperty()
  @IsUUID()
  repId!: string;

  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @ApiPropertyOptional({
    description:
      "Rep's GPS latitude when recording. Enforces the per-rep location lock " +
      '(customers.requireProximity); ignored for unrestricted reps.',
  })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  repLat?: number;

  @ApiPropertyOptional({ description: "Rep's GPS longitude when recording (see repLat)." })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  repLng?: number;

  @ApiPropertyOptional({
    description:
      'Amount in fils. Required for cash. For cheque it is derived from Σ cheques[].amount (ignored if sent).',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @ApiProperty({ enum: ['cash', 'cheque'] })
  @IsIn(['cash', 'cheque'])
  method!: 'cash' | 'cheque';

  @ApiPropertyOptional({ description: 'YYYY-MM-DD or ISO; defaults to now()' })
  @IsOptional()
  @IsDateString()
  collectedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;

  @ApiPropertyOptional({
    type: [ChequeInputDto],
    description: 'One or more cheques (required, non-empty, when method=cheque). Receipt total = Σ amounts.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ChequeInputDto)
  cheques?: ChequeInputDto[];

  /**
   * ONE cheque, the way older handsets send it — accepted, never required.
   *
   * The van app posted a singular `cheque` object with no amount on it. This DTO
   * declared only the plural, and the app's validation refuses a body carrying
   * any property it does not declare (forbidNonWhitelisted), so every cheque
   * collection a rep took was rejected with a 400 BEFORE the service ran. It
   * reached neither VanFlow nor the ERP, and the rep was never told.
   *
   * The app now sends `cheques`. This stays because the handsets in the field do
   * not all update on the day the server does, and a rep taking cheques with
   * last month's build should start working the moment this deploys rather than
   * when someone gets their phone. The service folds it into `cheques`, using
   * the collection's own `amount` — which is the amount the old app sent, and
   * the only one it had.
   */
  @ApiPropertyOptional({
    type: ChequeInputDto,
    description: 'Legacy single-cheque form from older app builds. Prefer `cheques`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LegacyChequeInputDto)
  cheque?: LegacyChequeInputDto;
}
