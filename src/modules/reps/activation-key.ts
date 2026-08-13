import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-salesman activation keys.
 *
 * A key is derived from the salesman's own code, so one key unlocks exactly one
 * seat: it cannot be copied to a second salesman, and a client cannot mint their
 * own without the secret.
 *
 *   key = base32( HMAC-SHA256(secret, "rep:" + code) )[0..15]  →  XXXX-XXXX-XXXX-XXXX
 *
 * ## What this does and does not protect
 *
 * The secret lives on the client's own server, because activation has to work
 * with no internet — a van in a dead spot cannot phone home. Anyone with root on
 * that box can read it and generate their own keys. That is inherent to offline
 * licensing, not a flaw to fix here: it raises the cost from "type any string"
 * to "breach the server", which is the realistic goal.
 *
 * If a stronger guarantee is ever needed, it has to be a signed licence file
 * checked against a PUBLIC key, with the private key never leaving the vendor.
 * That is a different design and a bigger change.
 */

/** Crockford base32 minus I, L, O, U — no character can be misread aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 16;
const GROUP = 4;

/** Everything a caller needs to check or issue a key. */
export interface ActivationKeyConfig {
  secret: string;
}

function encode(bytes: Buffer, chars: number): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/**
 * The canonical key for a salesman code. Used by the vendor to issue keys and by
 * the server to check them — one function, so the two can never disagree.
 */
export function activationKeyFor(code: string, cfg: ActivationKeyConfig): string {
  const digest = createHmac('sha256', cfg.secret)
    .update(`rep:${normalizeCode(code)}`)
    .digest();
  const raw = encode(digest, KEY_CHARS);
  return raw.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-');
}

/**
 * Compare a typed key against the expected one.
 *
 * Case, spaces and dashes are all forgiven — the key gets read down a phone line
 * and typed on a tablet, and rejecting "correct but lowercase" would generate
 * support calls that teach nothing.
 *
 * The comparison is constant-time so a caller cannot narrow the key one
 * character at a time by timing the response.
 */
export function verifyActivationKey(
  code: string,
  typed: string,
  cfg: ActivationKeyConfig,
): boolean {
  const expected = canonical(activationKeyFor(code, cfg));
  const given = canonical(typed);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/** Strip formatting and case so the same key typed any way still matches. */
function canonical(key: string): string {
  return key.replace(/[\s-]/g, '').toUpperCase();
}

/** Salesman codes are compared without surrounding whitespace or case. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
