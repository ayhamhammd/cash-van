import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { CreateVoucherDto } from '../../vouchers/dto/create-voucher.dto';
import { CreateCollectionDto } from '../../collections/dto/create-collection.dto';

/** Mobile idempotency key carried alongside any synced document. */
export class ClientRefDto {
  @ApiPropertyOptional({
    description:
      "The device's local id for this document. Replays with the same ref return the existing inbox row instead of creating a duplicate.",
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

export class ListInboxQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'posted', 'failed'] })
  @IsOptional()
  @IsIn(['pending', 'posted', 'failed'])
  status?: 'pending' | 'posted' | 'failed';

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

/** What the app gets back from a voucher intake. */
export class SyncVoucherResultDto {
  @ApiProperty() id!: string;
  @ApiProperty() voucherNumber!: string;
  @ApiProperty({ enum: ['pending', 'posted', 'failed'] }) status!: string;
  @ApiPropertyOptional() error?: string | null;
}
