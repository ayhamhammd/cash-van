import { decryptSecret } from './secret.util';

/**
 * Open a stored secret, or report that there isn't a usable one.
 *
 * WHY THIS EXISTS
 * Secrets are sealed with JOFOTARA_KMS_KEY (or a key derived from JWT_SECRET),
 * so a database restored onto another machine carries ciphertext THIS server
 * cannot open: AES-GCM fails its authentication tag and `decryptSecret` throws.
 * That is the normal state of every customer database restored onto a dev box,
 * and it used to surface as a bare HTTP 500 from the settings screen — an error
 * that tells whoever is looking nothing, and sends them hunting the network
 * instead of the key.
 *
 * Never rethrows. The caller's real question is "have I got a usable secret",
 * and a failed decryption answers that with "no": the remedy is to enter it
 * again either way, exactly as if none were stored.
 *
 * The reason is logged, because "nothing stored" and "stored, wrong machine"
 * are indistinguishable in the UI and only the log can tell them apart.
 */
export function readStoredSecret(
  blob: string | null | undefined,
  label: string,
  log: (message: string) => void = console.warn,
): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch (e) {
    log(
      `[settings] stored ${label} could not be decrypted — treating it as unset. ` +
        'This is expected on a database restored from another install: the ' +
        'encryption key differs, so the secret must be re-entered. ' +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
    return null;
  }
}
