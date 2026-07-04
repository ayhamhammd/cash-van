import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;

let cachedKey: Buffer | null = null;

/**
 * Reads the AES key from JOFOTARA_KMS_KEY env (32-byte hex string).
 * In dev, if the env is missing, a deterministic dev-only key is used so the
 * app can boot — DO NOT rely on this in production.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.JOFOTARA_KMS_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') {
    // No dedicated KMS key set (e.g. a mock-mode deploy). Derive a stable AES key
    // from JWT_SECRET — a Render-managed secret that never lives in git — so
    // stored secrets can still be encrypted. Set JOFOTARA_KMS_KEY for a dedicated
    // key before going live with real JoFotara (then re-save any stored secrets,
    // since the key changes).
    const seed = process.env.JWT_SECRET;
    if (seed) {
      // eslint-disable-next-line no-console
      console.warn(
        '[secret.util] JOFOTARA_KMS_KEY not set — deriving the encryption key from JWT_SECRET.',
      );
      cachedKey = createHash('sha256').update(`jofotara-kms:${seed}`).digest();
      return cachedKey;
    }
    throw new Error(
      'JOFOTARA_KMS_KEY (or JWT_SECRET) must be set in production',
    );
  }
  // Dev fallback — deterministic, NOT secret.
  cachedKey = Buffer.alloc(KEY_LEN, 0x42);
  return cachedKey;
}

/**
 * Encrypt a secret. Returns a single base64 string: `iv || ciphertext || authTag`.
 * Safe to store in the DB.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new TypeError('encryptSecret: plaintext required');
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

/** Reverse of encryptSecret. Throws on tamper / wrong key. */
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + AUTH_TAG_LEN + 1) {
    throw new Error('decryptSecret: ciphertext too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  );
}

/** Returns the last 4 chars of the plaintext, padded — used for masked display. */
export function maskSecret(plaintext: string): string {
  if (!plaintext) return '';
  return plaintext.length <= 4 ? '****' : `****${plaintext.slice(-4)}`;
}
