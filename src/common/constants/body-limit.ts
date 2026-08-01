/**
 * Max accepted request body size.
 *
 * Express/body-parser defaults to 100 kb, which is far too small for the
 * embedded logo `data:` URLs quote templates carry. Shared between the parser
 * config in `main.ts` and the 413 message in the global exception filter so the
 * two can never drift apart.
 */
export const BODY_LIMIT = '2mb';
