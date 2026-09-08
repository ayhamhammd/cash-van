import { encryptSecret } from './secret.util';
import { readStoredSecret } from './read-stored-secret';

/**
 * Regression cover for a real incident.
 *
 * A customer's database was restored onto the dev server. Every stored secret in
 * it was sealed with THAT install's encryption key, so decryption threw on the
 * new machine — and because nothing caught it, pressing "test connection" in the
 * settings screen answered a bare HTTP 500. The message named nothing, so the
 * hunt went to the network and the ERP URL, neither of which was involved: the
 * failure happened before any request was made.
 */
describe('readStoredSecret', () => {
  const quiet = () => undefined;

  it('returns the secret when it can be opened', () => {
    const blob = encryptSecret('erp_live_key_123');
    expect(readStoredSecret(blob, 'ERP API key', quiet)).toBe('erp_live_key_123');
  });

  it.each([[null], [undefined], ['']])('reports no secret for %p', (blob) => {
    expect(readStoredSecret(blob as string | null, 'ERP API key', quiet)).toBeNull();
  });

  it('reports no secret for ciphertext this machine cannot open', () => {
    // A tampered auth tag fails exactly as a foreign encryption key does — the
    // restored-database case, which must read as "no key", never as a throw.
    const buf = Buffer.from(encryptSecret('erp_live_key_123'), 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(readStoredSecret(buf.toString('base64'), 'ERP API key', quiet)).toBeNull();
  });

  it('reports no secret for a blob that is not ciphertext at all', () => {
    expect(readStoredSecret('not-encrypted-at-all', 'ERP API key', quiet)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    // The whole point: the caller is a settings read, and a settings screen that
    // 500s cannot be used to fix the very setting that is wrong.
    for (const blob of ['', 'x', '####', Buffer.alloc(64).toString('base64')]) {
      expect(() => readStoredSecret(blob, 'ERP API key', quiet)).not.toThrow();
    }
  });

  it('says why in the log, since the UI cannot tell the two cases apart', () => {
    const lines: string[] = [];
    readStoredSecret('not-encrypted-at-all', 'ERP API key', (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ERP API key');
    expect(lines[0]).toContain('re-entered');
  });

  it('stays silent when there was simply nothing stored', () => {
    const lines: string[] = [];
    readStoredSecret(null, 'ERP API key', (m) => lines.push(m));
    expect(lines).toHaveLength(0);
  });
});
