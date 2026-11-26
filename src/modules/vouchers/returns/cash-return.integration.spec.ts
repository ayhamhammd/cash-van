/**
 * Real-DB: who may pay a return back in cash, and how much
 * (docs/SPEC-cash-returns.md §5.2).
 *
 *  - the voucher's salesman decides, by his own switch — also when a manager's
 *    context re-runs the return (an approval);
 *  - a cash return may not exceed what is left of its sale: the sale's net
 *    total minus every return already made against it, cash or credit.
 *
 * Runs when DB_NAME is set, like the other integration specs.
 */
import { DataSource } from 'typeorm';

import { VouchersService } from '../vouchers.service';
import type { CreateVoucherDto } from '../dto/create-voucher.dto';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZCASHRET';

run('cash returns (real DB)', () => {
  let ds: DataSource;
  let svc: VouchersService;
  let ctx: { userId: string; role: string } | null = null;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }
  async function header(number: string, kind: 'SALE' | 'RETURN', netTotal: number, ref: string | null = null) {
    await q(
      `INSERT INTO voucher_headers
         (voucher_number, user_code, customer_number, in_date, trans_kind, is_posted, total, net_total, reference_voucher_number)
       VALUES ($1, $2, $3, now(), $4, true, $5, $5, $6)`,
      [number, `${P}-ALLOWED`, `${P}-C1`, kind, netTotal, ref],
    );
  }
  const ret = (amount: string, userCode = `${P}-ALLOWED`, ref = `${P}-S1`) =>
    ({
      transKind: 'RETURN',
      userCode,
      referenceVoucherNumber: ref,
      payments: [{ amount, paymentType: 'CASH' }],
    }) as unknown as CreateVoucherDto;
  const may = (dto: CreateVoucherDto) =>
    (svc as unknown as { mayReturnCash: (d: CreateVoucherDto) => Promise<boolean> }).mayReturnCash(dto);

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [__dirname + '/../../../**/*.entity.{ts,js}'],
      synchronize: false,
    });
    await ds.initialize();
    await purge();
    for (const [code, allowed, type] of [
      [`${P}-ALLOWED`, true, 'SALES'],
      [`${P}-PLAIN`, false, 'SALES'],
      [`${P}-MGR`, false, 'MANAGER'],
    ] as const) {
      await q(
        `INSERT INTO users (user_number, name, password_hash, user_type, can_cash_return) VALUES ($1, $1, 'x', $2, $3)`,
        [code, type, allowed],
      );
    }
    await q(`INSERT INTO customers (customer_number, customer_name, name_ar) VALUES ($1, 'Shop', 'Shop')`, [`${P}-C1`]);
    await header(`${P}-S1`, 'SALE', 50);
    await header(`${P}-R1`, 'RETURN', 20, `${P}-S1`); // a credit return already made

    svc = Object.create(VouchersService.prototype) as VouchersService;
    Object.assign(svc, { dataSource: ds, userCtx: { get: () => ctx } });
  }, 60_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  it('lets a salesman with the switch refund cash, and nobody else', async () => {
    expect(await may(ret('1'))).toBe(true);
    expect(await may(ret('1', `${P}-PLAIN`))).toBe(false);
    expect(await may(ret('1', `${P}-MGR`))).toBe(true); // an office user's own return
  });

  it("judges an approved return by its salesman, not the approving manager", async () => {
    const [mgr] = await q(`SELECT id FROM users WHERE user_number = $1`, [`${P}-MGR`]);
    ctx = { userId: mgr.id, role: 'manager' };
    expect(await may(ret('1', `${P}-PLAIN`))).toBe(false);
    ctx = null;
  });

  it('caps a cash return at what is left of its sale', async () => {
    expect(await svc.cashReturnOverSale(ret('30.000'))).toBeNull(); // 50 − 20 = 30 left
    expect(await svc.cashReturnOverSale(ret('30.001'))).toEqual({ saleNumber: `${P}-S1`, remaining: 30 });
  });

  it('leaves the return itself out when checking after it was saved', async () => {
    await header(`${P}-R2`, 'RETURN', 25, `${P}-S1`);
    expect(await svc.cashReturnOverSale(ret('25.000'), `${P}-R2`)).toBeNull();
    expect(await svc.cashReturnOverSale(ret('5.001'))).toEqual({ saleNumber: `${P}-S1`, remaining: 5 });
  });

  it('has nothing to measure without a sale', async () => {
    expect(await svc.cashReturnOverSale(ret('999', `${P}-ALLOWED`, `${P}-NOPE`))).toBeNull();
  });
});
