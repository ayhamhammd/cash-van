/**
 * What a cheque is missing before the ERP will register it.
 *
 * The ERP builds its Financial Paper out of the cheque NUMBER and the DUE DATE
 * and refuses a CHECK receipt without both — it cannot invent either, and a
 * paper it cannot identify cannot be chased, cleared or bounced.
 *
 * One rule, because four places ask it: the ERP push (which dead-letters on a
 * gap), the Export button (which refuses before queueing a push that cannot
 * succeed), the pending-exports list and the outbound queue (which flag the row
 * so the office is offered the form, not an error string), and the dashboard's
 * own collection form (which refuses a cheque an office user could have dated).
 * Four copies would disagree about what "missing" means the first time one of
 * them was changed.
 */
export type ChequeField = 'chequeNumber' | 'dueDate';

export interface ChequeGap {
  chequeId: string;
  missing: ChequeField[];
}

interface ChequeLike {
  id: string;
  chequeNumber?: string | null;
  dueDate?: string | Date | null;
}

/** The fields one cheque lacks — empty when it can be registered. */
export function chequeMissing(c: Omit<ChequeLike, 'id'>): ChequeField[] {
  const missing: ChequeField[] = [];
  if (!c.chequeNumber || !c.chequeNumber.trim()) missing.push('chequeNumber');
  // A date column can come back as a Date or a 'YYYY-MM-DD' string depending
  // on the driver; either is present. Only null/undefined/'' is missing.
  if (c.dueDate == null || c.dueDate === '') missing.push('dueDate');
  return missing;
}

/**
 * Every cheque on a collection that cannot be registered, with what it lacks.
 *
 * ALL cheques, not just the first the ERP receipt is keyed on: a collection of
 * two cheques where one is unidentified holds a paper nobody can chase, and the
 * office completing the form may as well complete it once.
 */
export function chequeGaps(cheques: ChequeLike[]): ChequeGap[] {
  return cheques
    .map((c) => ({ chequeId: c.id, missing: chequeMissing(c) }))
    .filter((g) => g.missing.length > 0);
}

/** "due date", "cheque number and due date" — for a message a person reads. */
export function describeMissing(missing: ChequeField[]): string {
  const words = missing.map((m) => (m === 'dueDate' ? 'due date' : 'cheque number'));
  return words.join(' and ');
}
