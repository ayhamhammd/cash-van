/**
 * Real-DB tests for "make van stock match the ERP".
 *
 * These write to the stock ledger, so they run against a real database and read
 * the balance back out of the real `item_balance` view. A mocked repository
 * would happily accept a correction line that the view then ignores — which is
 * the only way this feature can fail while looking like it worked.
 *
 * The ERP is a stub returning a chosen /van/stock snapshot, because the cases
 * worth pinning are the ones a live ERP will not produce on demand: an empty
 * snapshot, a van the ERP says is empty, a store with unsent documents.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ErpSyncService } from './erp-sync.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZREC';
const STORE = `${P}-V1`;
/** voucher_headers.user_code is a real FK to users.user_number. */
const USER_CODE = `${P}-U`;
const WH_NAME = `${P} Van One`;

run('stock reconciliation to the ERP (real DB)', () => {
  let ds: DataSource;

  /** What the stubbed ERP answers for GET /van/stock. */
  let erpSnapshot: Array<{ skuCode: string; warehouseName: string; quantity: number }> = [];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(
      `DELETE FROM voucher_transactions WHERE voucher_number IN
         (SELECT voucher_number FROM voucher_headers WHERE voucher_number LIKE $1)`,
      [`%${P}%`],
    );
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`%${P}%`]);
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1`, [`%${P}%`]);
    await q(`DELETE FROM item_units WHERE item_id IN (SELECT id FROM item_cart WHERE item_number LIKE $1)`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM warehouses WHERE wh_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  async function makeItem(n: string) {
    const [row] = await q(
      `INSERT INTO item_cart (item_number, sku, item_name, name_ar, barcode, price)
       VALUES ($1,$1,$1,$1,$1,1000) RETURNING id`,
      [n],
    );
    return row.id as string;
  }

  /** A posted voucher line — how stock gets onto a van in the first place. */
  async function stockIn(voucher: string, itemNumber: string, qty: number) {
    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, in_date, is_posted)
       VALUES ($1,'IN',$2, now(), TRUE)
       ON CONFLICT (voucher_number) DO NOTHING`,
      [voucher, USER_CODE],
    );
    await q(
      `INSERT INTO voucher_transactions
         (voucher_number, item_number, item_name, trans_kind, store_number,
          to_store_number, item_qty, signed_qty, qty_of_unit, unit_base_qty, stock_unit_code)
       VALUES ($1,$2,$2,'IN',$3,$3,$4,$4,$4,1,'')`,
      [voucher, itemNumber, STORE, qty],
    );
  }

  const onHand = async (itemNumber: string): Promise<number> => {
    const rows = await q(
      `SELECT COALESCE(SUM(qty),0)::float AS qty FROM item_balance
        WHERE stock_number = $1 AND item_number = $2`,
      [STORE, itemNumber],
    );
    return Number(rows[0]?.qty ?? 0);
  };

  /**
   * The service with only what these paths touch wired up. The ERP client is a
   * stub: `list('van/stock')` answers the chosen snapshot, and the movement
   * feed answers nothing, so a drained feed is the starting state.
   */
  function makeService(): ErpSyncService {
    const svc = Object.create(ErpSyncService.prototype) as Record<string, unknown>;
    svc.dataSource = ds;
    svc.settings = { getErpConfig: async () => ({ enabled: true, baseUrl: 'http://stub', apiKey: 'k' }) };
    svc.erp = {
      list: async (path: string) =>
        path === 'van/stock'
          ? { data: erpSnapshot, total: erpSnapshot.length }
          : { data: [], total: 0 },
    };
    svc.logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    svc.events = { emit: () => undefined };
    svc.headers = ds.getRepository('VoucherHeader');
    svc.txns = ds.getRepository('VoucherTransaction');
    svc.items = ds.getRepository('ItemCart');
    svc.itemUnits = ds.getRepository('ItemUnit');
    svc.idmap = ds.getRepository('ErpIdMap');
    svc.cursors = ds.getRepository('ErpSyncCursor');
    svc.whs = ds.getRepository('Warehouse');
    // The feed is already drained in these tests; the reconciliation's own call
    // to it would otherwise need the whole movement path stubbed as well.
    svc.pullAllMovements = async () => [];
    return svc as unknown as ErpSyncService;
  }

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
    await purge();
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  beforeEach(async () => {
    await purge();
    await q(
      `INSERT INTO warehouses (wh_number, wh_name) VALUES ($1,$2)`,
      [STORE, WH_NAME],
    );
    await q(
      `INSERT INTO users (user_number, name, password_hash, user_type)
       VALUES ($1,$1,'x','SALES') ON CONFLICT (user_number) DO NOTHING`,
      [USER_CODE],
    );
    // The correcting voucher is signed 'admin', the same as a mirrored ERP
    // movement — so that user has to exist here as it does on a real install.
    await q(
      `INSERT INTO users (user_number, name, password_hash, user_type)
       VALUES ('admin','admin','x','ADMIN') ON CONFLICT (user_number) DO NOTHING`,
    );
    erpSnapshot = [];
  });

  it('adds what the ERP has and the van does not', async () => {
    // The ERP loaded the van from a template; the movement that carried it was
    // dropped by the feed, so cash-van never saw the goods arrive.
    await makeItem(`${P}-A`);
    erpSnapshot = [{ skuCode: `${P}-A`, warehouseName: WH_NAME, quantity: 24 }];

    const res = await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-A`)).toBe(24);
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].pools).toBe(1);
    expect(res.applied[0].absQtyCorrected).toBe(24);
  });

  it('takes off what the van has and the ERP does not', async () => {
    await makeItem(`${P}-B`);
    await stockIn(`${P}-IN-B`, `${P}-B`, 30);
    // The van was closed in the ERP — it holds nothing now.
    erpSnapshot = [{ skuCode: `${P}-OTHER`, warehouseName: WH_NAME, quantity: 1 }];
    await makeItem(`${P}-OTHER`);

    await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-B`)).toBe(0);
  });

  it('lands exactly on the ERP figure when both sides hold some', async () => {
    await makeItem(`${P}-C`);
    await stockIn(`${P}-IN-C`, `${P}-C`, 10);
    erpSnapshot = [{ skuCode: `${P}-C`, warehouseName: WH_NAME, quantity: 17 }];

    await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-C`)).toBe(17);
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    await makeItem(`${P}-D`);
    await stockIn(`${P}-IN-D`, `${P}-D`, 3);
    erpSnapshot = [{ skuCode: `${P}-D`, warehouseName: WH_NAME, quantity: 9 }];

    const first = await makeService().reconcileStockToErp();
    const second = await makeService().reconcileStockToErp();

    expect(first.applied).toHaveLength(1);
    // Converging, not compounding: the correction is measured against an
    // absolute, so running it twice cannot double-apply.
    expect(second.applied).toHaveLength(0);
    expect(await onHand(`${P}-D`)).toBe(9);
  });

  it('refuses an empty snapshot rather than emptying every van', async () => {
    await makeItem(`${P}-E`);
    await stockIn(`${P}-IN-E`, `${P}-E`, 40);
    erpSnapshot = []; // a broken read, not a company with no stock

    await expect(makeService().reconcileStockToErp()).rejects.toThrow(/empty stock snapshot/i);
    expect(await onHand(`${P}-E`)).toBe(40);
  });

  it('leaves a store alone while its documents are still queued for the ERP', async () => {
    await makeItem(`${P}-F`);
    await stockIn(`${P}-SALE-F`, `${P}-F`, 12);
    // A van sale that has not reached the ERP: the ERP still shows the goods on
    // the van. Correcting to it would put sold stock back.
    await q(
      `INSERT INTO erp_outbox (kind, ref, status, attempts)
       VALUES ('SALE_INVOICE', $1, 'pending', 0)`,
      [`${P}-SALE-F`],
    );
    erpSnapshot = [{ skuCode: `${P}-F`, warehouseName: WH_NAME, quantity: 99 }];

    const res = await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-F`)).toBe(12);
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0].storeNumber).toBe(STORE);
    expect(res.skipped[0].reason).toMatch(/on their way to the ERP/);
  });

  it('corrects again once the queue has drained', async () => {
    await makeItem(`${P}-G`);
    await stockIn(`${P}-SALE-G`, `${P}-G`, 12);
    await q(
      `INSERT INTO erp_outbox (kind, ref, status, attempts)
       VALUES ('SALE_INVOICE', $1, 'posted', 1)`,
      [`${P}-SALE-G`],
    );
    erpSnapshot = [{ skuCode: `${P}-G`, warehouseName: WH_NAME, quantity: 20 }];

    // 'posted' is done and gone — only pending and failed hold a store back.
    await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-G`)).toBe(20);
  });

  it('changes nothing on a dry run, but reports what it would change', async () => {
    await makeItem(`${P}-H`);
    await stockIn(`${P}-IN-H`, `${P}-H`, 5);
    erpSnapshot = [{ skuCode: `${P}-H`, warehouseName: WH_NAME, quantity: 50 }];

    const res = await makeService().reconcileStockToErp({ dryRun: true });

    expect(await onHand(`${P}-H`)).toBe(5);
    expect(res.dryRun).toBe(true);
    expect(res.applied[0].pools).toBe(1);
    expect(res.applied[0].absQtyCorrected).toBe(45);
    // No voucher was written, and the report says so rather than naming one.
    expect(res.applied[0].voucherNumber).toBeNull();
  });

  it('writes one voucher for a store however many pools it corrects', async () => {
    await makeItem(`${P}-I1`);
    await makeItem(`${P}-I2`);
    await stockIn(`${P}-IN-I`, `${P}-I1`, 100); // too many
    erpSnapshot = [
      { skuCode: `${P}-I1`, warehouseName: WH_NAME, quantity: 4 },
      { skuCode: `${P}-I2`, warehouseName: WH_NAME, quantity: 7 }, // missing entirely
    ];

    const res = await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-I1`)).toBe(4);
    expect(await onHand(`${P}-I2`)).toBe(7);
    // One act of reconciliation, one document — both directions inside it.
    expect(res.applied[0].pools).toBe(2);
    const rows = await q(
      `SELECT COUNT(*)::int AS n FROM voucher_headers WHERE voucher_number LIKE 'ERP-RECON-%'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('never pushes its own correction back to the ERP', async () => {
    await makeItem(`${P}-J`);
    erpSnapshot = [{ skuCode: `${P}-J`, warehouseName: WH_NAME, quantity: 6 }];

    await makeService().reconcileStockToErp();

    // The correction describes stock the ERP already holds. Queuing it would
    // apply the difference over there a second time, and the two sides would
    // walk apart in exactly the way this exists to stop.
    const queued = await q(
      `SELECT COUNT(*)::int AS n FROM erp_outbox WHERE ref LIKE 'ERP-RECON-%'`,
    );
    expect(queued[0].n).toBe(0);
  });

  it('ignores an ERP warehouse that matches no cash-van store', async () => {
    await makeItem(`${P}-K`);
    await stockIn(`${P}-IN-K`, `${P}-K`, 8);
    erpSnapshot = [
      { skuCode: `${P}-K`, warehouseName: 'A warehouse cash-van has never heard of', quantity: 0 },
      { skuCode: `${P}-K`, warehouseName: WH_NAME, quantity: 8 },
    ];

    const res = await makeService().reconcileStockToErp();

    expect(await onHand(`${P}-K`)).toBe(8);
    expect(res.unmatchedWarehouses).toContain('A warehouse cash-van has never heard of');
  });
});
