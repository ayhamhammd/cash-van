import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  classifyIntakeFailure,
  intakeBackoffMs,
  INTAKE_BACKOFF_MS,
  INTAKE_MAX_ATTEMPTS,
} from './intake-failure';

/**
 * Whether a staged document is worth trying again.
 *
 * Every promotion failure used to be treated alike — `failed`, then silence,
 * until a human happened to open the inbox. The two kinds need opposite
 * handling: a sale promoted ahead of the transfer that stocks the van resolves
 * itself within seconds, while a customer over their credit limit will still be
 * over it on the eighth attempt.
 *
 * These pin the classification to the exceptions the voucher and collection
 * services actually throw, which is why HTTP status alone will not do: a 409 is
 * terminal when it is a credit limit and retryable when it is stock.
 */
describe('classifyIntakeFailure', () => {
  // ── Wait: the prerequisite may still arrive ──────────────────────────────

  it('retries a sale the van cannot cover yet', () => {
    // The load TRANSFER is very often queued behind the sale in one batch.
    expect(
      classifyIntakeFailure(
        new BadRequestException(
          'Not enough stock of 23232 in store 110101: have 0, need 5',
        ),
      ),
    ).toBe('retryable');
  });

  it('retries the van-stock guard by its code', () => {
    expect(
      classifyIntakeFailure(
        new ConflictException({ code: 'INSUFFICIENT_STOCK', itemNumber: '23232' }),
      ),
    ).toBe('retryable');
  });

  it('retries a catalogue row the ERP sync has not delivered', () => {
    expect(
      classifyIntakeFailure(new NotFoundException('Item unit abc-123 not found')),
    ).toBe('retryable');
  });

  it('retries an unrecognised failure', () => {
    // A dropped connection or a deadlock is likelier than a permanent refusal,
    // and MAX_ATTEMPTS bounds the cost of being wrong. Guessing terminal would
    // discard a recoverable sale on the first stumble.
    expect(classifyIntakeFailure(new Error('ECONNRESET'))).toBe('retryable');
    expect(classifyIntakeFailure(undefined)).toBe('retryable');
  });

  // ── Stop: a person must act ──────────────────────────────────────────────

  it('stops on a credit limit', () => {
    expect(
      classifyIntakeFailure(
        new ConflictException({ code: 'CREDIT_LIMIT_EXCEEDED', limit: 500 }),
      ),
    ).toBe('terminal');
  });

  it('stops on a credit hold', () => {
    expect(classifyIntakeFailure(new ConflictException({ code: 'CREDIT_HOLD' }))).toBe(
      'terminal',
    );
  });

  it('stops when the rep was outside the customer geofence', () => {
    // An offline sale carries the position it was MADE at, so a later retry
    // asks the identical question and gets the identical answer.
    expect(
      classifyIntakeFailure(
        new ForbiddenException({ code: 'outside_customer_geofence', distanceM: 900 }),
      ),
    ).toBe('terminal');
  });

  it('stops on a policy the rep may not bypass', () => {
    expect(
      classifyIntakeFailure(new ForbiddenException('APPROVAL_REQUIRED:RETURN_VOUCHER')),
    ).toBe('terminal');
    expect(classifyIntakeFailure(new ForbiddenException('RETURN_NOT_ALLOWED'))).toBe(
      'terminal',
    );
    expect(
      classifyIntakeFailure(new ForbiddenException('APPROVAL_REQUIRED:PRICE_OVERRIDE')),
    ).toBe('terminal');
  });

  it('stops when the voucher number is already taken', () => {
    // Retrying replays the same collision forever. Someone has to renumber it,
    // and only after confirming it is not a re-upload of a posted sale.
    expect(
      classifyIntakeFailure(
        new ConflictException('Voucher INV-110101000009 already exists'),
      ),
    ).toBe('terminal');
  });

  it('stops on a payload no retry can repair', () => {
    expect(classifyIntakeFailure(new BadRequestException('unitPrice must be >= 0'))).toBe(
      'terminal',
    );
    expect(
      classifyIntakeFailure(
        new BadRequestException('اختر العميل قبل حفظ الفاتورة — لا يمكن ترحيلها إلى ERP بدون عميل.'),
      ),
    ).toBe('terminal');
  });

  // ── Ordering ─────────────────────────────────────────────────────────────

  it('reads "not found" as retryable even though it contains a terminal word', () => {
    // Retryable patterns are tested first on purpose: "Item unit X not found"
    // must not be swallowed by the validation patterns.
    expect(
      classifyIntakeFailure(new NotFoundException('Customer 9001 is required, not found')),
    ).toBe('retryable');
  });
});

describe('intakeBackoffMs', () => {
  it('is front-loaded, because the common retryable case resolves in seconds', () => {
    expect(intakeBackoffMs(0)).toBe(30_000);
    expect(intakeBackoffMs(1)).toBe(120_000);
  });

  it('tops out at a day rather than growing without bound', () => {
    expect(intakeBackoffMs(INTAKE_MAX_ATTEMPTS)).toBe(86_400_000);
    expect(intakeBackoffMs(9_999)).toBe(86_400_000);
  });

  it('never returns a negative or undefined delay', () => {
    expect(intakeBackoffMs(-5)).toBe(INTAKE_BACKOFF_MS[0]);
  });
});
