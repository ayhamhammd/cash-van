/**
 * The tenant every pre-existing row was assigned to when the tenancy migration
 * ran. A single-company install has exactly this one tenant, so tokens issued
 * before tenancy existed (JwtPayload v < 3, which carry no `tid`) resolve here
 * and keep working across the upgrade.
 *
 * Must match DEFAULT_TENANT_ID in `1723700000000-TenancyAndRls`.
 */
export const DEFAULT_TENANT_ID =
  process.env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';
