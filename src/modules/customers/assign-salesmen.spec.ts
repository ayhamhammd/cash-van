import { Workbook } from 'exceljs';

import { CustomersService } from './customers.service';

/**
 * Unit tests for assignSalesmenFromXlsx() — the bulk customer→salesman Excel
 * upload. Column 1 is the customer NAME (matched case-insensitively on
 * customerName / name_ar / name_en); column 2 is the salesman number (matched on
 * rep code, login number, or van number). A name that hits more than one customer
 * is reported as ambiguous and never assigned. The service is built off the
 * prototype with only the two collaborators the method touches stubbed.
 */
type Cust = {
  id: string;
  customerName?: string;
  nameAr?: string;
  nameEn?: string | null;
  repId?: string | null;
};
type Rep = {
  repId: string;
  code?: string | null;
  userNumber?: string | null;
  vanNumber?: string | null;
};

async function xlsx(rows: Array<[string, string]>): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

function makeSvc(opts: { customers: Cust[]; reps: Rep[] }) {
  const updates: Array<{ crit: unknown; patch: unknown }> = [];
  const repo = {
    update: jest.fn((crit: unknown, patch: unknown) => {
      updates.push({ crit, patch });
      return Promise.resolve({});
    }),
  };
  const manager = {
    query: jest.fn().mockResolvedValue(
      opts.reps.map((r) => ({
        repId: r.repId,
        code: r.code ?? null,
        userNumber: r.userNumber ?? null,
        vanNumber: r.vanNumber ?? null,
      })),
    ),
    transaction: jest.fn(async (cb: (em: unknown) => Promise<void>) =>
      cb({ getRepository: () => repo }),
    ),
  };
  const customers = {
    find: jest.fn().mockResolvedValue(
      opts.customers.map((c) => ({
        id: c.id,
        customerName: c.customerName ?? '',
        nameAr: c.nameAr ?? '',
        nameEn: c.nameEn ?? null,
        repId: c.repId ?? null,
      })),
    ),
    manager,
  };
  const events = { emit: jest.fn() };
  const svc = Object.create(CustomersService.prototype) as CustomersService;
  (svc as unknown as { customers: unknown }).customers = customers;
  (svc as unknown as { events: unknown }).events = events;
  return { svc, events, updates, repo };
}

const REPS: Rep[] = [
  { repId: 'rep-1', code: 'R1', userNumber: '101', vanNumber: 'V1' },
  { repId: 'rep-2', code: 'R2', userNumber: '102', vanNumber: 'V2' },
];

describe('CustomersService.assignSalesmenFromXlsx (match customer by NAME)', () => {
  it('matches by name (any of the three fields, case-insensitive), reports ambiguous/unmatched', async () => {
    const { svc, events, updates } = makeSvc({
      customers: [
        { id: 'c1', customerName: 'Alpha Store', nameAr: 'متجر ألفا', repId: null },
        { id: 'c2', customerName: 'Beta Shop', repId: 'rep-2' },
        { id: 'c3', customerName: 'Dup Name', repId: null },
        { id: 'c4', customerName: 'Dup Name', repId: null }, // same name → ambiguous
      ],
      reps: REPS,
    });
    const buf = await xlsx([
      ['Customer', 'Salesman'], // header — column 2 has no digit, so it is skipped
      ['  alpha   store ', '101'], // → c1 by name (normalized), rep-1 by login number → assigned
      ['Beta Shop', 'R2'], // → c2 by name, rep-2 by code; already rep-2 → unchanged
      ['Dup Name', '101'], // → two customers share the name → ambiguous, untouched
      ['Ghost', '101'], // → no such customer → unmatched customer
      ['متجر ألفا', '999'], // → c1 by Arabic name, but salesman 999 unknown → unmatched salesman
    ]);

    const r = await svc.assignSalesmenFromXlsx(buf);

    expect(r.total).toBe(5);
    expect(r.assigned).toBe(1);
    expect(r.unchanged).toBe(1);
    expect(r.ambiguousCustomers).toEqual(['Dup Name']);
    expect(r.unmatchedCustomers).toEqual(['Ghost']);
    expect(r.unmatchedSalesmen).toEqual(['999']);
    // Only the one real change is written, and vans are signalled exactly once.
    expect(updates).toEqual([{ crit: { id: 'c1' }, patch: { repId: 'rep-1' } }]);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('customer.changed', expect.any(Object));
  });

  it('keeps the first row when it is real data (column 2 has a digit → not a header)', async () => {
    const { svc, updates } = makeSvc({
      customers: [{ id: 'c1', customerName: 'Alpha Store', repId: null }],
      reps: REPS,
    });
    const buf = await xlsx([['Alpha Store', '101']]);

    const r = await svc.assignSalesmenFromXlsx(buf);

    expect(r.total).toBe(1);
    expect(r.assigned).toBe(1);
    expect(updates).toEqual([{ crit: { id: 'c1' }, patch: { repId: 'rep-1' } }]);
  });

  it('never assigns an ambiguous name even when the salesman is valid', async () => {
    const { svc, events, updates } = makeSvc({
      customers: [
        { id: 'c1', customerName: 'Same', repId: null },
        { id: 'c2', customerName: 'same', repId: null }, // differs only by case → still ambiguous
      ],
      reps: REPS,
    });
    const buf = await xlsx([['Same', '101']]);

    const r = await svc.assignSalesmenFromXlsx(buf);

    expect(r.assigned).toBe(0);
    expect(r.ambiguousCustomers).toEqual(['Same']);
    expect(updates).toEqual([]);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
