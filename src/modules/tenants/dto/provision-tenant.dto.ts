import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ProvisionTenantDto {
  /** The company's id in the CRM. Makes provisioning idempotent. */
  @IsUUID()
  crmTenantId!: string;

  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9_-]+$/)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  /** The company's first login. Omit only when users arrive some other way. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  adminUserNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  adminPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  adminName?: string;
}
