import type { CreateVoucherDto } from '../dto/create-voucher.dto';

/**
 * A return is credited to the customer's account — and nothing else.
 *
 * The business rule: no money is handed back on a return, whether the sale was
 * cash, Visa or on account. The phone disagreed: a RETURN inherited the payment
 * type of the sale it reversed, so a return against a cash sale arrived as a
 * CASH payment — a cash refund. Everything downstream believed it: the rep's
 * expected cash was reduced by it, and the customer's balance was left alone
 * because only CREDIT payment rows move `total_debt`.
 *
 * So every RETURN is stored as CREDIT here, at intake, whatever the phone sent.
 * At intake rather than in the app alone because handsets update slowly and a
 * sale made offline syncs days later: an old build in the field keeps sending
 * cash refunds, and this is the one place every one of them passes through.
 *
 * The amount is kept exactly — several rows (a split the old app could send)
 * become one CREDIT row of their sum, dated like the first. A return with no
 * payment rows is left alone: there is nothing to reclassify, and inventing an
 * amount here would guess at the total the voucher computes later.
 *
 * Mutates [dto] in place, like the other intake steps in VouchersService.create.
 */
export function returnsAreCredit(dto: CreateVoucherDto): void {
  if (dto.transKind !== 'RETURN') return;
  const rows = dto.payments ?? [];
  if (!rows.length) return;
  if (rows.length === 1) {
    rows[0].paymentType = 'CREDIT';
    return;
  }
  // Summed in thousandths so "0.1" + "0.2" is exactly 0.300, not 0.30000000000000004.
  const milli = rows.reduce((s, p) => s + Math.round((Number(p.amount) || 0) * 1000), 0);
  dto.payments = [{ ...rows[0], amount: (milli / 1000).toFixed(3), paymentType: 'CREDIT' }];
}
