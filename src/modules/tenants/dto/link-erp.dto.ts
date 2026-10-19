import { IsOptional, IsString, IsUrl } from 'class-validator';

export class LinkErpDto {
  /** Origin only — `/api/v1` is appended by the client, and stripped here if sent. */
  @IsUrl({ require_tld: false })
  baseUrl!: string;

  /** Shown once by the ERP when it mints the key, so it may be absent on a retry. */
  @IsOptional()
  @IsString()
  apiKey?: string | null;

  /** Which ERP warehouse the vans draw stock from, when the CRM knows it. */
  @IsOptional()
  @IsString()
  vanStore?: string | null;
}
