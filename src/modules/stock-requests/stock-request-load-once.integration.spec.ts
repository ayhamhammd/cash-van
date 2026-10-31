import { DataSource } from 'typeorm';

import { StockRequestsService } from './stock-requests.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZLOAD';
const REQUESTER = '00000000-0000-4000-8000-00000000a001';

run('a stock request moves the goods once (real DB)', () => {
  let ds: DataSource;
  let vouchersMade: string[];
  let failNextVoucher: boolean;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM stock_requests WHERE request_number LIKE $1`, [`${P}%`]);
  }

  async function approvedRequest(n: string): Promise<string> {
    const [r] = await q(
      `INSERT INTO stock_requests (request_number, status, requester_user, van_store_number, source_store_number)
       VALUES ($1, 'approved', $2, 'V1', 'MAIN') RETURNING id`,
      [`${P}-${n}`, REQUESTER],
    );
    await q(
      `INSERT INTO stock_request_items (request_id, item_number, item_name, qty_of_unit, base_qty, approved_base_qty)
       VALUES ($1, 'ITEM-1', 'Item', 4, 4, 4)`,
      [r.id],
    );
    return r.id as string;
  }

  function makeService(): StockRequestsService {
    const svc = Object.create(StockRequestsService.prototype) as Record<string, unknown>;
    svc.repo = ds.getRepository('StockRequest');
    svc.reps = { findOne: async () => null };
    svc.itemUnits = { findOne: async () => null };
    svc.repScope = { assertCanSeeRep: async () => undefined };
    svc.notifications = { notifyUser: async () => undefined };
    svc.events = { emit: () => undefined };
    svc.assertCan = async () => undefined;
    svc.vouchers = {
      create: async () => {
        await new Promise((r) => setTimeout(r, 20));
        if (failNextVoucher) {
          failNextVoucher = false;
          throw new Error('voucher refused');
        }
        const n = `TRF-${P}-${vouchersMade.length + 1}`;
        vouchersMade.push(n);
        return { voucherNumber: n };
      },
    };
    return svc as unknown as StockRequestsService;
  }

  const rep = { sub: REQUESTER } as never;
  const office = { sub: 'office' } as never;
  const officeTransfer = { userCode: 'admin', transactions: [] } as never;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [__dirname + '/../../**/*.entity.{ts,js}'],
      synchronize: false,
    });
    await ds.initialize();
  }, 120_000);

  beforeEach(async () => {
    await purge();
    vouchersMade = [];
    failNextVoucher = false;
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  it('refuses the office transfer after the salesman received it — the reported case', async () => {
    const id = await approvedRequest('A');
    const svc = makeService();

    await svc.markReceived(id, rep);
    await expect(svc.fulfilWithTransfer(id, officeTransfer, office)).rejects.toThrow(
      /already loaded onto the van by voucher TRF-ZZLOAD-1/,
    );

    expect(vouchersMade).toEqual([`TRF-${P}-1`]);
  });

  it('refuses the salesman receipt after the office transferred it', async () => {
    const id = await approvedRequest('B');
    const svc = makeService();

    await svc.fulfilWithTransfer(id, officeTransfer, office);
    await expect(svc.markReceived(id, rep)).rejects.toThrow(/already loaded/);

    expect(vouchersMade).toHaveLength(1);
  });

  it('moves the goods once when both press at the same moment', async () => {
    const id = await approvedRequest('C');
    const svc = makeService();

    const results = await Promise.allSettled([
      svc.markReceived(id, rep),
      svc.fulfilWithTransfer(id, officeTransfer, office),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(vouchersMade).toHaveLength(1);
    const [row] = await q(`SELECT status, transfer_voucher_number FROM stock_requests WHERE id = $1`, [id]);
    expect(row).toEqual({ status: 'received', transfer_voucher_number: vouchersMade[0] });
  });

  it('opens the request again when the transfer itself fails', async () => {
    const id = await approvedRequest('D');
    const svc = makeService();
    failNextVoucher = true;

    await expect(svc.fulfilWithTransfer(id, officeTransfer, office)).rejects.toThrow(/voucher refused/);
    const [row] = await q(`SELECT status FROM stock_requests WHERE id = $1`, [id]);
    expect(row.status).toBe('approved');

    await svc.markReceived(id, rep);
    expect(vouchersMade).toHaveLength(1);
  });

  it('refuses to record an outside transfer on a request that was already loaded', async () => {
    const id = await approvedRequest('E');
    const svc = makeService();

    await svc.markReceived(id, rep);
    await expect(svc.attachTransfer(id, 'TRF-OTHER', office)).rejects.toThrow(/already loaded/);
  });
});
