/**
 * Issue an activation key for a salesman code.
 *
 * Run where SALESMAN_ACTIVATION_SECRET is set — normally the vendor's machine,
 * NOT the client's server. Keys are derived, not stored, so the same code always
 * yields the same key and there is nothing to keep in sync.
 *
 *   npm run key -- 101
 *   npm run key -- 101 102 103
 */
import { config as loadEnv } from 'dotenv';

import { activationKeyFor } from '../src/modules/reps/activation-key';

loadEnv();

const codes = process.argv.slice(2).filter(Boolean);
const secret = process.env.SALESMAN_ACTIVATION_SECRET ?? '';

if (!secret) {
  console.error(
    'SALESMAN_ACTIVATION_SECRET is not set. Without it every key would be wrong,\n' +
      'so nothing is printed rather than printing keys that will be rejected.',
  );
  process.exit(1);
}
if (codes.length === 0) {
  console.error('Usage: npm run key -- <salesmanCode> [moreCodes...]');
  process.exit(1);
}

for (const code of codes) {
  console.log(`${code.padEnd(12)} ${activationKeyFor(code, { secret })}`);
}
