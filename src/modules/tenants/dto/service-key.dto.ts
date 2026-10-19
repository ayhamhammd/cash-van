import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * A third-party credential the CRM is putting into this company's VanFlow.
 *
 * The value arrives once and is stored encrypted. Nothing here ever reads it
 * back out to an API response — the settings screen shows the last four
 * characters, same as it does for a key typed by hand.
 */
export class SetServiceKeyDto {
  /** The company, by the id the CRM knows it by. */
  @IsString()
  crmTenantId!: string;

  @IsIn(['maps', 'ai', 'jofotara'])
  kind!: 'maps' | 'ai' | 'jofotara';

  /** Null clears it — that is what "this company has no AI" looks like. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  value?: string | null;

  @IsOptional()
  @IsIn(['company', 'platform', 'none'])
  source?: 'company' | 'platform' | 'none';

  /** The AI provider name, or the JoFotara client id. Never a secret. */
  @IsOptional()
  @IsObject()
  meta?: Record<string, string>;
}

/**
 * A new password for the company's super admin, set in the CRM.
 *
 * Without this, resetting it there fixes the CRM login and leaves the customer
 * locked out of the product they actually work in.
 */
export class SetAdminPasswordDto {
  @IsString()
  crmTenantId!: string;

  /** Their username here, which is their CRM email. */
  @IsString()
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}
