import { decryptSecret, encryptSecret, maskSecret } from './secret.util';

describe('secret.util', () => {
  beforeAll(() => {
    process.env.JOFOTARA_KMS_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  it('roundtrips', () => {
    const plaintext = 'my-very-secret-jofotara-key-12345';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('hello');
    const tampered =
      Buffer.from(encrypted, 'base64').toString('hex').slice(0, -2) + '00';
    const tamperedB64 = Buffer.from(tampered, 'hex').toString('base64');
    expect(() => decryptSecret(tamperedB64)).toThrow();
  });

  it('rejects too-short ciphertext', () => {
    expect(() => decryptSecret('YWJjZA==')).toThrow(/too short/);
  });

  it('produces different ciphertext for identical plaintext (random IV)', () => {
    const a = encryptSecret('repeat');
    const b = encryptSecret('repeat');
    expect(a).not.toBe(b);
  });

  describe('maskSecret', () => {
    it('shows last 4', () => {
      expect(maskSecret('abcdef1234')).toBe('****1234');
    });

    it('masks short secrets entirely', () => {
      expect(maskSecret('abc')).toBe('****');
    });

    it('handles empty', () => {
      expect(maskSecret('')).toBe('');
    });
  });
});
