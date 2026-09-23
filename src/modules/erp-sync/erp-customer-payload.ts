/**
 * The body of POST /api/v1/customers — the ERP's copy of a cash-van customer.
 *
 * ONE builder for the two paths that send it: the immediate push when a
 * customer is created, and the outbox's retry when that push could not land.
 * They were written separately and already had to be kept in step by hand;
 * a field added to one and not the other is a customer that arrives complete
 * or incomplete depending on whether the ERP happened to be up at the time.
 */
export interface ErpCustomerSource {
  code: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  taxNumber?: string | null;
  /** JOD major; the ERP scales it on receipt. */
  creditLimit?: number | null;
  /**
   * The code of the rep the customer belongs to — which IS the ERP salesman
   * code, as it is the van warehouse code: one identity, the same one every
   * receipt already sends as `salesmanCode`.
   */
  repCode?: string | null;
}

export function erpCustomerBody(c: ErpCustomerSource): Record<string, unknown> {
  const repCode = c.repCode?.trim();
  return {
    code: c.code,
    name: c.name,
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.taxNumber ? { taxNumber: c.taxNumber } : {}),
    ...(c.creditLimit != null ? { creditLimit: Number(c.creditLimit) } : {}),
    // Only when there is one. An ERP that predates the field drops it (its
    // schema strips unknown keys), and one that has it assigns the customer —
    // or, for a code it does not know, creates the customer unassigned and says
    // so in `warnings`, rather than refusing a customer the van is selling to.
    ...(repCode ? { salesmanCode: repCode } : {}),
  };
}

/** The ERP's `warnings`, if the response carried any. */
export function erpWarnings(data: unknown): string[] {
  const w = (data as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [];
}
