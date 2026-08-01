/**
 * Provider-aware sanity check on an LLM API key.
 *
 * Without this, pasting the wrong key is only discovered later, as a 401 from
 * the vendor in the middle of a chat — and the vendor's message names ITS key
 * format, not ours, so it reads like the AI feature is broken rather than
 * misconfigured. The realistic mistake is pasting a key from elsewhere in this
 * same Settings screen (the ERP key sits a few fields away and looks similar).
 *
 * These are prefix checks, not validity checks: only the vendor can say whether
 * a key is live. So the rule is narrow — reject what is definitely wrong, never
 * block something merely unfamiliar, since vendors change key formats and a
 * false rejection would lock an admin out of a working key.
 */

/** Keys that belong to THIS system and can never be a vendor LLM key. */
const OUR_OWN_KEY_PREFIXES = ['erp_', 'cashvan_', 'vanflow_'];

const EXPECTED_PREFIX: Record<string, { prefix: string; label: string }> = {
  openai: { prefix: 'sk-', label: 'OpenAI' },
  anthropic: { prefix: 'sk-ant-', label: 'Anthropic' },
};

/**
 * Returns a human-readable problem, or null when the key looks plausible.
 * Gemini keys have no stable public prefix, so only the own-key check applies.
 */
export function validateAiApiKey(
  provider: string | undefined,
  apiKey: string,
): string | null {
  const key = apiKey.trim();
  if (!key) return null; // "omit to keep current key" is handled by the caller

  const own = OUR_OWN_KEY_PREFIXES.find((p) => key.startsWith(p));
  if (own) {
    return `That looks like this system's own "${own}" key, not an AI provider key. Copy the key from your AI provider's dashboard.`;
  }

  const expected = EXPECTED_PREFIX[(provider ?? '').toLowerCase()];
  if (expected && !key.startsWith(expected.prefix)) {
    return `${expected.label} API keys start with "${expected.prefix}". Check you copied the key from the right provider.`;
  }

  return null;
}
