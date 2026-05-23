import { SetMetadata } from '@nestjs/common';

/**
 * Excludes a route from the global AuditInterceptor.
 * Use for noisy/sensitive non-domain mutations (login, token refresh, bulk
 * GPS ingestion) where an audit row per call adds noise without value.
 */
export const SKIP_AUDIT_KEY = 'skipAudit';
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
