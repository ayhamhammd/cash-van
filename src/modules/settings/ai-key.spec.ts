import { validateAiApiKey } from './ai-key.util';

/**
 * Regression cover for a real incident: an ERP API key (`erp_…`) was pasted into
 * the AI key field, and the only symptom was a confusing 401 from OpenAI naming
 * ITS key format, mid-chat, long after the mistake.
 */
describe('validateAiApiKey', () => {
  it('rejects this system’s own ERP key, the mistake that actually happened', () => {
    expect(validateAiApiKey('openai', 'erp_d10e81c1f52bded8fceb')).toMatch(
      /this system.s own "erp_" key/,
    );
  });

  it.each([['cashvan_abc123'], ['vanflow_abc123']])('rejects our other key style %s', (k) => {
    expect(validateAiApiKey('openai', k)).toMatch(/not an AI provider key/);
  });

  it('tells the admin the expected OpenAI prefix', () => {
    expect(validateAiApiKey('openai', 'AIzaSySomethingGoogleish')).toMatch(
      /OpenAI API keys start with "sk-"/,
    );
  });

  it('accepts a plausible OpenAI key', () => {
    expect(validateAiApiKey('openai', 'sk-proj-abc123def456')).toBeNull();
  });

  it('requires the narrower sk-ant- prefix for Anthropic', () => {
    expect(validateAiApiKey('anthropic', 'sk-abc123')).toMatch(/start with "sk-ant-"/);
    expect(validateAiApiKey('anthropic', 'sk-ant-api03-abc')).toBeNull();
  });

  it('lets any non-own key through for gemini, which has no stable prefix', () => {
    expect(validateAiApiKey('gemini', 'AIzaSyWhatever')).toBeNull();
    expect(validateAiApiKey('gemini', 'erp_nope')).toMatch(/not an AI provider key/);
  });

  it('does not judge an unknown provider beyond the own-key check', () => {
    expect(validateAiApiKey('some-new-vendor', 'xyz-123')).toBeNull();
    expect(validateAiApiKey(undefined, 'xyz-123')).toBeNull();
  });

  it.each([[''], ['   ']])('treats %s as "keep the current key", not an error', (k) => {
    expect(validateAiApiKey('openai', k)).toBeNull();
  });

  it('ignores surrounding whitespace from a sloppy paste', () => {
    expect(validateAiApiKey('openai', '  sk-proj-abc  ')).toBeNull();
    expect(validateAiApiKey('openai', '  erp_abc  ')).toMatch(/not an AI provider key/);
  });
});
