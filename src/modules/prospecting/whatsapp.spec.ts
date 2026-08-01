import { ConfigService } from '@nestjs/config';

import { WhatsappService } from './whatsapp.service';

/** Minimal ConfigService stand-in over a flat `whatsapp.*` map. */
function svc(overrides: Record<string, unknown> = {}): WhatsappService {
  const values: Record<string, unknown> = {
    'whatsapp.baseUrl': 'http://openwa:2785',
    'whatsapp.apiKey': 'k',
    'whatsapp.sessionId': 'sales',
    'whatsapp.countryCode': '962',
    'whatsapp.minIntervalMs': 100,
    'whatsapp.dailyCap': 150,
    ...overrides,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new WhatsappService(config);
}

describe('WhatsappService.toChatId', () => {
  const s = svc();

  it.each([
    ['07 7212 8611', '962772128611@c.us'], // Places national format
    ['(06) 461 4846', '96264614846@c.us'], // landline with area code
    ['+962 7 7212 8611', '962772128611@c.us'], // E.164 with spaces
    ['00962772128611', '962772128611@c.us'], // 00 international prefix
    ['962772128611', '962772128611@c.us'], // already prefixed, bare
    ['772128611', '962772128611@c.us'], // bare local, no trunk zero
  ])('normalizes %s', (raw, expected) => {
    expect(s.toChatId(raw)).toBe(expected);
  });

  it('leaves a foreign country code alone rather than double-prefixing', () => {
    expect(s.toChatId('+971 50 123 4567')).toBe('971501234567@c.us');
  });

  it('honours a non-Jordanian default country code', () => {
    expect(svc({ 'whatsapp.countryCode': '20' }).toChatId('01001234567')).toBe(
      '201001234567@c.us',
    );
  });

  it.each([[''], ['   '], [null], [undefined]])('rejects empty input %s', (raw) => {
    expect(() => s.toChatId(raw)).toThrow(/No phone number/);
  });

  it.each([['123'], ['+1 234 567 890 123 456']])('rejects %s as out of range', (raw) => {
    expect(() => s.toChatId(raw)).toThrow(/looks invalid/);
  });
});

describe('WhatsappService.sendText', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-1' }),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('posts the OpenWA send-text shape with the API key', async () => {
    const res = await svc().sendText('0772128611', 'hello');

    expect(res).toEqual({ chatId: '962772128611@c.us', messageId: 'msg-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://openwa:2785/api/sessions/sales/messages/send-text');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
    expect(JSON.parse(init.body as string)).toEqual({
      chatId: '962772128611@c.us',
      text: 'hello',
    });
  });

  it('serializes sends and spaces them by at least the minimum interval', async () => {
    const s = svc({ 'whatsapp.minIntervalMs': 100 });
    const started = Date.now();
    await Promise.all([s.sendText('0772128611', 'a'), s.sendText('0772128612', 'b')]);

    // Jitter is ±20%, so the floor for the second send is 80ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops at the daily cap instead of burning the number', async () => {
    const s = svc({ 'whatsapp.minIntervalMs': 5000, 'whatsapp.dailyCap': 1 });
    await s.sendText('0772128611', 'a');

    await expect(s.sendText('0772128612', 'b')).rejects.toThrow(/daily cap reached/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second never went out
  });

  it('does not poison the queue when one send fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg-2' }),
        text: async () => '',
      });
    const s = svc({ 'whatsapp.minIntervalMs': 10 });

    await expect(s.sendText('0772128611', 'a')).rejects.toThrow();
    await expect(s.sendText('0772128612', 'b')).resolves.toMatchObject({
      messageId: 'msg-2',
    });
  });

  it('reports an unscanned session as a clear operator error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, text: async () => '' });

    await expect(svc().sendText('0772128611', 'a')).rejects.toThrow(/re-scan the QR/);
  });

  it('refuses to send when the gateway is not configured', async () => {
    await expect(
      svc({ 'whatsapp.baseUrl': '' }).sendText('0772128611', 'a'),
    ).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
