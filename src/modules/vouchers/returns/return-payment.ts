import type { CreateVoucherDto } from '../dto/create-voucher.dto';

/**
 * How a return pays the customer back: CREDIT on the customer's account, or
 * CASH out of the van (docs/SPEC-cash-returns.md).
 *
 * History: on 2026-09-25 every return became credit — the phone had been
 * inheriting the sale's payment type, so a return against a cash sale arrived
 * as a cash refund nobody chose, and the rep's expected cash shrank by it. From
 * 2026-11-26 a salesman the office allows (`users.can_cash_return`) chooses,
 * and a cash return is a real cash refund again: it comes off his expected cash
 * and leaves the customer's balance alone (only CREDIT rows move total_debt).
 *
 * So a RETURN keeps a single CASH row only when every row it sent is CASH and
 * [keepCash] says the creator may refund cash. Everything else — Visa, cheque,
 * a split, a salesman without the switch, every old build — becomes ONE CREDIT
 * row, exactly as before. At intake because handsets update slowly and offline
 * documents sync days late; every return passes through here.
 *
 * Amounts are kept exactly; several rows become one row of their sum, dated
 * like the first. A return with no payment rows is left alone: there is nothing
 * to classify, and inventing an amount would guess at the voucher's total.
 *
 * Mutates [dto] in place, like the other intake steps in VouchersService.create.
 * Returns the method the return now carries, or null when it isn't a return
 * with payment rows.
 */
export function classifyReturnPayment(
  dto: CreateVoucherDto,
  keepCash: boolean,
): 'CASH' | 'CREDIT' | null {
  if (dto.transKind !== 'RETURN') return null;
  const rows = dto.payments ?? [];
  if (!rows.length) return null;
  const method = keepCash && rows.every((p) => p.paymentType === 'CASH') ? 'CASH' : 'CREDIT';
  if (rows.length === 1) {
    rows[0].paymentType = method;
    return method;
  }
  dto.payments = [{ ...rows[0], amount: (returnPaymentMilli(dto) / 1000).toFixed(3), paymentType: method }];
  return method;
}

/** Whether a return's rows are all CASH — i.e. the salesman asked for a cash refund. */
export function asksForCash(dto: CreateVoucherDto): boolean {
  const rows = dto.payments ?? [];
  return dto.transKind === 'RETURN' && rows.length > 0 && rows.every((p) => p.paymentType === 'CASH');
}

/**
 * A voucher's payment rows summed in thousandths of a JOD, so "0.1" + "0.2" is
 * exactly 300, not 300.00000000000006.
 */
export function returnPaymentMilli(dto: CreateVoucherDto): number {
  return (dto.payments ?? []).reduce((s, p) => s + Math.round((Number(p.amount) || 0) * 1000), 0);
}
