/**
 * Real-DB tests for the `container_balances` view — the arithmetic the whole
 * feature rests on.
 *
 * The figure is DERIVED, with no table behind it:
 *
 *   customer holds = Σ (base pieces sold × containers_per_base_unit)
 *                  + Σ CONTAINER_OUT qty
 *                  − Σ CONTAINER_IN  qty
 *
 * There is no `qty_returned` counter and no allocation against a particular
 * invoice, which is what makes partial returns, returns months later, and
 * returns spanning any number of invoices work with no special handling. These
 * tests pin that, and above all the multiplication: a line entered in CARTONS
 * must count every container in the carton, not one per line.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ContainersService } from './containers.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

/** Prefix every fixture row, so the purge can never reach real data. */
const P = 'ZZCNT';

run('container_balances (real DB)', () => {
  let ds: DataSource;
  let containers: ContainersService;
  let repId = '';
  let otherRepId = '';

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM voucher_transactions WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM customers WHERE customer_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  async function makeRep(code: string): Promise<string> {
    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type)
       VALUES ($1,$1,'x','SALES') RETURNING id`,
      [code],
    );
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar) VALUES ($1,$2,$2) RETURNING id`,
      [u.id, code],
    );
    return r.id as string;
  }

  async function makeCustomer(n: string, rep: string | null = repId) {
    await q(
      `INSERT INTO customers (customer_number, customer_name, name_ar, rep_id)
       VALUES ($1,$1,$1,$2)`,
      [n, rep],
    );
  }

  /** A container item — the empty bucket itself. */
  async function makeContainer(n: string) {
    await q(
      `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar, is_returnable_container)
       VALUES ($1,$1,$1,$1,$1,true)`,
      [n],
    );
  }

  /** An ordinary item that SHIPS IN `container`, carrying `perBase` of them per base piece. */
  async function makeProduct(n: string, container: string | null, perBase = 1) {
    await q(
      `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar,
                              container_item_number, containers_per_base_unit)
       VALUES ($1,$1,$1,$1,$1,$2,$3)`,
      [n, container, perBase],
    );
  }

  /**
   * One voucher, one line. `unitBaseQty` is how many BASE PIECES one unit of
   * the line is — 1 for a tub, 4 for a carton of four.
   */
  async function voucher(opts: {
    number: string;
    kind: string;
    customer: string | null;
    item: string;
    qty: number;
    unitBaseQty?: number | null;
    /** Pieces of this line that came back as PRODUCT (the return allocator sets it). */
    qtyReturned?: number | null;
    userCode?: string;
    posted?: boolean;
    date?: string;
  }) {
    await q(
      `INSERT INTO voucher_headers (voucher_number, user_code, trans_kind, customer_number,
                                    is_posted, in_date)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        opts.number,
        opts.userCode ?? `${P}1`,
        opts.kind,
        opts.customer,
        opts.posted ?? true,
        opts.date ?? '2026-03-01T10:00:00Z',
      ],
    );
    await q(
      `INSERT INTO voucher_transactions (voucher_number, item_number, item_name, trans_kind,
                                         item_qty, unit_base_qty, qty_returned)
       VALUES ($1,$2,$2,$3,$4,$5,$6)`,
      [
        opts.number,
        opts.item,
        opts.kind,
        opts.qty,
        opts.unitBaseQty ?? null,
        opts.qtyReturned ?? 0, // NOT NULL in the schema; 0 = nothing came back
      ],
    );
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME,
      synchronize: false,
    });
    await ds.initialize();
    containers = new ContainersService(ds);
    // `voucher_headers.trans_kind` is a foreign key. The app ensures these on
    // every startup (STANDARD_TRANS_KINDS) and the migration seeds the two
    // container kinds, but a database that has only had migrations applied has
    // no SALE row — so insert what these fixtures post, and leave them be:
    // reference rows every real deployment carries anyway.
    await q(
      `INSERT INTO transaction_kinds (trans_kind, trans_name, sign)
       VALUES ('SALE','بيع',-1), ('CONTAINER_IN','استلام فوارغ',1),
              ('CONTAINER_OUT','تسليم فوارغ',-1)
       ON CONFLICT (trans_kind) DO NOTHING`,
    );
    await purge();
    repId = await makeRep(`${P}1`);
    otherRepId = await makeRep(`${P}2`);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  describe('what the sale implies', () => {
    const BUCKET = `${P}-BUCKET`;
    const TUB = `${P}-TUB`;
    const CUST = `${P}-C1`;

    beforeAll(async () => {
      await makeContainer(BUCKET);
      await makeProduct(TUB, BUCKET, 1);
      await makeCustomer(CUST);
      // Ten 6 kg tubs, one bucket each, sold as single pieces.
      await voucher({ number: `${P}-INV1`, kind: 'SALE', customer: CUST, item: TUB, qty: 10, unitBaseQty: 1 });
    });

    it('counts a container per base piece sold, with nothing documented', async () => {
      const [row] = await containers.forCustomer(CUST);
      expect(row.outstanding).toBe(10);
      expect(row.containerItemNumber).toBe(BUCKET);
    });

    it('ages from the sale that put them out, and names the rep who last moved them', async () => {
      const [row] = await containers.forCustomer(CUST);
      expect(row.oldestOutAt).toBe('2026-03-01T10:00:00.000Z');
      expect(row.lastUserCode).toBe(`${P}1`);
      expect(row.daysOutstanding).toBeGreaterThan(0);
    });
  });

  describe('a line entered in cartons', () => {
    const CRATE = `${P}-CRATE`;
    const CARTON = `${P}-CARTON`;
    const CUST = `${P}-C2`;

    beforeAll(async () => {
      await makeContainer(CRATE);
      await makeProduct(CARTON, CRATE, 1);
      await makeCustomer(CUST);
      // THREE cartons, each holding FOUR base pieces, one crate per piece.
      await voucher({ number: `${P}-INV2`, kind: 'SALE', customer: CUST, item: CARTON, qty: 3, unitBaseQty: 4 });
    });

    it('counts every container in the carton, not one per line', async () => {
      // The bug this guards: counting line quantity (3) instead of base pieces
      // (3 × 4). It under-states the balance by the carton size and is
      // invisible until someone counts the crates in a yard.
      const [row] = await containers.forCustomer(CUST);
      expect(row.outstanding).toBe(12);
    });
  });

  describe('a product carrying several containers per piece', () => {
    const PALLET = `${P}-PALLET`;
    const BULK = `${P}-BULK`;
    const CUST = `${P}-C3`;

    beforeAll(async () => {
      await makeContainer(PALLET);
      await makeProduct(BULK, PALLET, 4); // four containers per base piece
      await makeCustomer(CUST);
      await voucher({ number: `${P}-INV3`, kind: 'SALE', customer: CUST, item: BULK, qty: 53, unitBaseQty: 1 });
    });

    it('multiplies by containers_per_base_unit', async () => {
      const [row] = await containers.forCustomer(CUST);
      expect(row.outstanding).toBe(212); // 53 pieces × 4
    });
  });

  describe('returns, with no allocation against an invoice', () => {
    const BUCKET = `${P}-B4`;
    const TUB = `${P}-T4`;
    const CUST = `${P}-C4`;

    beforeAll(async () => {
      await makeContainer(BUCKET);
      await makeProduct(TUB, BUCKET, 1);
      await makeCustomer(CUST);
      await voucher({ number: `${P}-INV4`, kind: 'SALE', customer: CUST, item: TUB, qty: 10, unitBaseQty: 1, date: '2026-03-01T10:00:00Z' });
      // Three back on one visit, two on a later one — spanning no particular
      // invoice, which is the point of deriving rather than allocating.
      await voucher({ number: `${P}-CIN4a`, kind: 'CONTAINER_IN', customer: CUST, item: BUCKET, qty: 3, unitBaseQty: 1, date: '2026-03-05T10:00:00Z' });
      await voucher({ number: `${P}-CIN4b`, kind: 'CONTAINER_IN', customer: CUST, item: BUCKET, qty: 2, unitBaseQty: 1, date: '2026-03-09T10:00:00Z' });
    });

    it('subtracts every return, whenever it came back', async () => {
      const [row] = await containers.forCustomer(CUST);
      expect(row.outstanding).toBe(5); // 10 − 3 − 2
    });

    it('still ages from the oldest movement that put containers OUT', async () => {
      // Not from the last return: the buckets have been out since the sale, and
      // handing some back does not reset the clock on the rest.
      const [row] = await containers.forCustomer(CUST);
      expect(row.oldestOutAt).toBe('2026-03-01T10:00:00.000Z');
      expect(row.lastMovementAt).toBe('2026-03-09T10:00:00.000Z');
    });
  });

  describe('packaging lent with no sale behind it', () => {
    const CRATE = `${P}-B5`;
    const CUST = `${P}-C5`;

    beforeAll(async () => {
      await makeContainer(CRATE);
      await makeCustomer(CUST);
      // A stack of crates to another company — no invoice anywhere.
      await voucher({ number: `${P}-COUT5`, kind: 'CONTAINER_OUT', customer: CUST, item: CRATE, qty: 20, unitBaseQty: 1 });
    });

    it('counts as outstanding, which is why CONTAINER_OUT exists at all', async () => {
      const [row] = await containers.forCustomer(CUST);
      expect(row.outstanding).toBe(20);
    });
  });

  describe('goods returned as product', () => {
    const BUCKET = `${P}-BR`;
    const TUB = `${P}-TR`;
    const CUST = `${P}-CR`;
    const CARTON = `${P}-TRC`;
    const CUST2 = `${P}-CR2`;

    beforeAll(async () => {
      await makeContainer(BUCKET);
      await makeProduct(TUB, BUCKET, 1);
      await makeProduct(CARTON, BUCKET, 1);
      await makeCustomer(CUST);
      await makeCustomer(CUST2);
      // Ten tubs sold, three of them handed back AS PRODUCT.
      await voucher({
        number: `${P}-INVR`, kind: 'SALE', customer: CUST,
        item: TUB, qty: 10, unitBaseQty: 1, qtyReturned: 3,
      });
      // The same, entered in cartons of four: two cartons back out of five.
      await voucher({
        number: `${P}-INVR2`, kind: 'SALE', customer: CUST2,
        item: CARTON, qty: 5, unitBaseQty: 4, qtyReturned: 2,
      });
    });

    it('does not count a container that left with the goods', async () => {
      // A tub returned as PRODUCT took its bucket with it, so it never stayed
      // with the customer. Counting all ten would overstate what is owed, and
      // an empty handed back on its own is a CONTAINER_IN — so counting the
      // product return here as well would double-count it.
      const [row] = await containers.forCustomer(CUST);
      expect(row.outstanding).toBe(7); // 10 sold − 3 returned
    });

    it('nets the return off BEFORE multiplying out the carton', async () => {
      // (5 − 2) cartons × 4 pieces = 12. Netting after the multiplication would
      // give 5×4 − 2 = 18, and subtracting whole cartons as single pieces is the
      // easy way to get this wrong.
      const [row] = await containers.forCustomer(CUST2);
      expect(row.outstanding).toBe(12);
    });
  });

  describe('what must NOT count', () => {
    const BUCKET = `${P}-B6`;
    const TUB = `${P}-T6`;
    const PLAIN = `${P}-T6b`;
    const DRAFT_CUST = `${P}-C6`;
    const SETTLED = `${P}-C7`;
    const PLAIN_CUST = `${P}-C8`;

    beforeAll(async () => {
      await makeContainer(BUCKET);
      await makeProduct(TUB, BUCKET, 1);
      await makeProduct(PLAIN, null); // ships in nothing
      await makeCustomer(DRAFT_CUST);
      await makeCustomer(SETTLED);
      await makeCustomer(PLAIN_CUST);
      await voucher({ number: `${P}-DRAFT`, kind: 'SALE', customer: DRAFT_CUST, item: TUB, qty: 7, unitBaseQty: 1, posted: false });
      await voucher({ number: `${P}-INV7`, kind: 'SALE', customer: SETTLED, item: TUB, qty: 4, unitBaseQty: 1 });
      await voucher({ number: `${P}-CIN7`, kind: 'CONTAINER_IN', customer: SETTLED, item: BUCKET, qty: 4, unitBaseQty: 1 });
      await voucher({ number: `${P}-INV8`, kind: 'SALE', customer: PLAIN_CUST, item: PLAIN, qty: 9, unitBaseQty: 1 });
    });

    it('ignores a draft, so an unposted sale owes nothing', async () => {
      expect(await containers.forCustomer(DRAFT_CUST)).toEqual([]);
    });

    it('drops a customer who has returned everything', async () => {
      // The view's HAVING: a net zero is not a row. A settled customer on a
      // chase list is how a rep learns to ignore the chase list.
      expect(await containers.forCustomer(SETTLED)).toEqual([]);
    });

    it('ignores a product that ships in no container', async () => {
      expect(await containers.forCustomer(PLAIN_CUST)).toEqual([]);
    });
  });

  describe('one row per customer and container', () => {
    const BUCKET = `${P}-B9`;
    const CRATE = `${P}-B9b`;
    const CUST = `${P}-C9`;

    beforeAll(async () => {
      await makeContainer(BUCKET);
      await makeContainer(CRATE);
      await makeCustomer(CUST);
      await voucher({ number: `${P}-COUT9a`, kind: 'CONTAINER_OUT', customer: CUST, item: BUCKET, qty: 7, unitBaseQty: 1 });
      await voucher({ number: `${P}-COUT9b`, kind: 'CONTAINER_OUT', customer: CUST, item: CRATE, qty: 2, unitBaseQty: 1 });
    });

    it('never totals two kinds of packaging into one figure', async () => {
      const rows = await containers.forCustomer(CUST);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.outstanding).sort((a, b) => a - b)).toEqual([2, 7]);
    });
  });

  describe('the rep scope, against real rep_id columns', () => {
    const CRATE = `${P}-BX`;
    const MINE = `${P}-CX1`;
    const THEIRS = `${P}-CX2`;

    beforeAll(async () => {
      await makeContainer(CRATE);
      await makeCustomer(MINE, repId);
      await makeCustomer(THEIRS, otherRepId);
      await voucher({ number: `${P}-COUTX1`, kind: 'CONTAINER_OUT', customer: MINE, item: CRATE, qty: 5, unitBaseQty: 1 });
      // Moved by the SAME rep, but the customer belongs to another: scoping is
      // by who owns the customer, so this must not appear for our rep.
      await voucher({ number: `${P}-COUTX2`, kind: 'CONTAINER_OUT', customer: THEIRS, item: CRATE, qty: 6, unitBaseQty: 1 });
    });

    it('shows a scoped caller only their own customers’ packaging', async () => {
      const rows = await containers.balances({ containerItemNumber: CRATE, visibleRepIds: [repId] });
      expect(rows.map((r) => r.customerNumber)).toEqual([MINE]);
    });

    it('shows an unrestricted caller both', async () => {
      const rows = await containers.balances({ containerItemNumber: CRATE, visibleRepIds: null });
      expect(rows.map((r) => r.customerNumber).sort()).toEqual([MINE, THEIRS]);
    });

    it('shows a scoped caller with no salesmen nothing at all', async () => {
      const rows = await containers.balances({ containerItemNumber: CRATE, visibleRepIds: [] });
      expect(rows).toEqual([]);
    });

    it('scopes the totals to match the list', async () => {
      const rows = await containers.totals({ visibleRepIds: [repId] });
      const crate = rows.find((r) => r.containerItemNumber === CRATE);
      // Only our rep's customer, so the other rep's six crates are absent from
      // both the row and its customer count.
      expect(crate?.outstanding).toBe(5);
      expect(crate?.customers).toBe(1);
    });
  });

  describe('what the schema refuses to represent', () => {
    it('will not let a container itself ship in a container', async () => {
      // One level only. Without this a cycle is representable and the balance
      // walk can recurse — and a bucket could owe a bucket.
      await expect(
        q(
          `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar,
                                  is_returnable_container, container_item_number)
           VALUES ($1,$1,$1,$1,$1,true,$2)`,
          [`${P}-CYC`, `${P}-BUCKET`],
        ),
      ).rejects.toThrow(/item_cart_container_one_level_chk/);
    });

    it('will not let an item be its own container', async () => {
      await expect(
        q(
          `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar,
                                  container_item_number)
           VALUES ($1,$1,$1,$1,$1,$1)`,
          [`${P}-SELF`],
        ),
      ).rejects.toThrow(/item_cart_container_one_level_chk/);
    });

    it('will not accept zero containers per base piece', async () => {
      // Zero would silently erase the packaging of everything that ships in it.
      await expect(
        q(
          `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar,
                                  containers_per_base_unit)
           VALUES ($1,$1,$1,$1,$1,0)`,
          [`${P}-ZERO`],
        ),
      ).rejects.toThrow(/item_cart_containers_per_unit_chk/);
    });
  });

  describe('the chase list', () => {
    it('ages in whole days and filters on how long they have been out', async () => {
      const old = await containers.balances({ minDaysOutstanding: 1, limit: 1000 });
      expect(old.length).toBeGreaterThan(0);
      for (const row of old) expect(row.daysOutstanding).toBeGreaterThanOrEqual(1);

      // Nothing in these fixtures is a century old.
      expect(await containers.balances({ minDaysOutstanding: 36500 })).toEqual([]);
    });
  });
});
