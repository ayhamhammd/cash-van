import { createHmac } from 'crypto';

/**
 * Deterministic, salted HMAC-SHA256 of a phone number.
 *
 * Stored alongside the raw phone so AI calls can reference customers by a
 * non-reversible token instead of leaking the actual number (PRIVACY-FIRST).
 *
 * The same input always yields the same hash (so it can be used for lookups),
 * but the hash can't be reversed without the secret.
 */
function getSecret(): string {
  const secret = process.env.PHONE_HASH_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PHONE_HASH_SECRET must be set (>= 16 chars) in production');
  }
  return 'dev-only-phone-hash-secret-change-me';
}

/** Normalizes then HMACs a phone number. Returns null for empty input. */
export function hashPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normalized = phone.replace(/[\s-()]/g, '').trim();
  if (!normalized) return null;
  return createHmac('sha256', getSecret()).update(normalized).digest('hex');
}
