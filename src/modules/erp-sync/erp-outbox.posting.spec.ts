import { Logger } from '@nestjs/common';

import { ErpOutboxService } from './erp-outbox.service';
import type { ErpOutbox, ErpOutboxKind } from './entities/erp-outbox.entity';

/**
 * The ERP reports its GL outcome in the sales-invoice response and never raises
 * it as an error, so these two private helpers are the only thing standing
 * between a misconfigured org and silently unposted revenue.
 */
interface PostingInternals {
  extractPostingInfo(data: unknown): { journalId: string | null; paymentSkipped: boolean };
  warnOnPostingGap(row: ErpOutbox): void;
  logger: Logger;
}

/**
 * The service is exercised directly off its prototype — neither helper touches a
 * repository or the HTTP client, so no dependency needs wiring. Cast via
 * `unknown` because intersecting the class with its own private members
 * collapses to `never`.
 */
const svc = Object.create(ErpOutboxService.prototype) as unknown as PostingInternals;

const row = (over: Partial<ErpOutbox> = {}): ErpOutbox =>
  ({
    kind: 'SALE_INVOICE' as ErpOutboxKind,
    ref: 'VAN-1',
    resultRef: 'INV-9',
    journalId: 'J-1',
    paymentSkipped: false,
    ...over,
  }) as ErpOutbox;

describe('extractPostingInfo', () => {
  it('reads the ERP success envelope', () => {
    expect(
      svc.extractPostingInfo({
        success: true,
        data: { invoiceNumber: 'INV-9', journalId: '8f3c', paymentSkipped: false },
      }),
    ).toEqual({ journalId: '8f3c', paymentSkipped: false });
  });

  it('reads an unwrapped body too', () => {
    expect(svc.extractPostingInfo({ journalId: '8f3c' })).toEqual({
      journalId: '8f3c',
      paymentSkipped: false,
    });
  });

  it('treats a skipped journal as null, not an error', () => {
    expect(
      svc.extractPostingInfo({ data: { invoiceNumber: 'INV-9', journalId: null } }),
    ).toEqual({ journalId: null, paymentSkipped: false });
  });

  it('flags paymentSkipped when the ERP refused the inline payment', () => {
    expect(svc.extractPostingInfo({ data: { journalId: 'J', paymentSkipped: true } })).toEqual({
      journalId: 'J',
      paymentSkipped: true,
    });
  });

  it.each([[null], [undefined], ['not json'], [42]])('survives %s', (data) => {
    expect(svc.extractPostingInfo(data)).toEqual({ journalId: null, paymentSkipped: false });
  });

  it('ignores a non-string journalId rather than persisting junk', () => {
    expect(svc.extractPostingInfo({ data: { journalId: { id: 1 } } }).journalId).toBeNull();
  });
});

describe('warnOnPostingGap', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    Object.defineProperty(svc, 'logger', { value: new Logger(), configurable: true });
  });
  afterEach(() => warn.mockRestore());

  it('says nothing when the sale posted cleanly', () => {
    svc.warnOnPostingGap(row());
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, and says do not re-push, when no journal came back', () => {
    svc.warnOnPostingGap(row({ journalId: null }));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('VAN-1');
    expect(msg).toContain('PAYMENT_METHOD_ACCOUNT_NOT_CONFIGURED');
    expect(msg).toMatch(/Do NOT re-push/i);
  });

  it('warns separately when the ERP downgraded the sale to credit', () => {
    svc.warnOnPostingGap(row({ paymentSkipped: true }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/booked as CREDIT/);
  });

  it('reports both problems when they coincide', () => {
    svc.warnOnPostingGap(row({ journalId: null, paymentSkipped: true }));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['SALES_RETURN'], // the ERP posts no journal for these at all
    ['PAYMENT'], // journalId is not documented on this response
    ['SALE_SPLIT_RECEIPT'],
  ])('stays quiet for %s, where a missing journalId proves nothing', (kind) => {
    svc.warnOnPostingGap(row({ kind: kind as ErpOutboxKind, journalId: null }));
    expect(warn).not.toHaveBeenCalled();
  });
});
