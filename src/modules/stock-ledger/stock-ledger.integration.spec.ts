/**
 * The stock ledger, against a real database (docs/SPEC-single-stock-model.md).
 *
 * Everything here goes through the real triggers, because the triggers ARE the
 * feature: the one place a posted voucher line becomes a movement and a balance.
 * A mocked repository would pass every one of these while the database did
 * something else.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { StockLedgerService } from './stock-ledger.service';
import { VanStockService } from '../products/van-stock.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZLED';
const VAN = `${P}-V1`;
const DEPOT = `${P}-D1`;
const USER_CODE = `${P}-U`;

interface VectorLine {
  item: string;
  qty: number;
  factor: number;
  pool: string;
  bonus?: boolean;
}
interface VectorCase {
  name: string;
  start: Record<string, number>;
  docs: Array<{ kind: 'SALE' | 'RETURN'; lines: VectorLine[]; gifts?: Array<{ item: string; qty: number }> }>;
  expect: Record<string, number>;
}
const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../../docs/stock-vectors.json'), 'utf8'),
) as { cases: VectorCase[] };

run('stock ledger (real DB)', () => {
  let ds: DataSource;
  let serial = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(
      `DELETE FROM voucher_transactions WHERE voucher_number IN
         (SELECT voucher_number FROM voucher_headers WHERE voucher_number LIKE $1)`,
      [`${P}%`],
    );
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_inbox WHERE client_ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM stock_movements WHERE store_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM stock_balance WHERE store_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE name_ar LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM warehouses WHERE wh_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
  }

  const item = (letter: string) => `${P}-${letter}`;

  async function makeItem(n: string) {
    await q(
      `INSERT INTO item_cart (item_number, sku, item_name, name_ar, barcode, price)
       VALUES ($1,$1,$1,$1,$1,1000) ON CONFLICT DO NOTHING`,
      [n],
    );
  }

  /** A voucher header; `posted` false leaves it a draft. */
  async function header(kind: string, posted = true): Promise<string> {
    serial += 1;
    const number = `${P}-${kind}-${serial}`;
    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, in_date, is_posted)
       VALUES ($1,$2,$3, now(), $4)`,
      [number, kind, USER_CODE, posted],
    );
    return number;
  }

  /** One line, shaped the way the voucher service writes it: base pieces in item_qty. */
  async function line(
    voucher: string,
    kind: string,
    l: { item: string; baseQty: number; pool?: string; from?: string | null; to?: string | null },
  ): Promise<string> {
    const [row] = await q(
      `INSERT INTO voucher_transactions
         (voucher_number, item_number, item_name, trans_kind, store_number,
          from_store_number, to_store_number, item_qty, signed_qty, qty_of_unit, unit_base_qty,
          stock_unit_code)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,0,$7,1,$8) RETURNING id`,
      [voucher, l.item, kind, l.from ?? l.to ?? null, l.from ?? null, l.to ?? null, l.baseQty, l.pool ?? ''],
    );
    return row.id as string;
  }

  const milli = async (store: string, itemNumber: string, pool = ''): Promise<number> => {
    const rows = await q(
      `SELECT qty_milli FROM stock_balance WHERE store_number = $1 AND item_number = $2 AND stock_unit_code = $3`,
      [store, itemNumber, pool],
    );
    return Number(rows[0]?.qty_milli ?? 0);
  };
  /** What every reader sees — the item_balance view, now over the stored balance. */
  const viewQty = async (store: string, itemNumber: string, pool = ''): Promise<number> => {
    const rows = await q(
      `SELECT qty::float AS qty FROM item_balance WHERE stock_number = $1 AND item_number = $2 AND stock_unit_code = $3`,
      [store, itemNumber, pool],
    );
    return Number(rows[0]?.qty ?? 0);
  };

  const ledger = () => new StockLedgerService(ds);
  /** No pool of this test's stores differs from a full replay of its vouchers. */
  const expectVerified = async () => {
    const { differences } = await ledger().verify();
    expect(differences.filter((d) => d.storeNumber.startsWith(P))).toEqual([]);
  };

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
    // The kinds the seed installs; a bare migrated schema has only TRANSFER/IN/OUT.
    await q(
      `INSERT INTO transaction_kinds (trans_kind, trans_name, sign)
       VALUES ('SALE','بيع',-1), ('RETURN','مرتجع',1), ('IN','إدخال',1), ('TRANSFER','تحويل',0)
       ON CONFLICT (trans_kind) DO NOTHING`,
    );
    await purge();
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  beforeEach(async () => {
    await purge();
    await q(`INSERT INTO warehouses (wh_number, wh_name) VALUES ($1,$1), ($2,$2)`, [VAN, DEPOT]);
    await q(
      `INSERT INTO users (user_number, name, password_hash, user_type)
       VALUES ($1,$1,'x','SALES') ON CONFLICT (user_number) DO NOTHING`,
      [USER_CODE],
    );
    for (const l of ['A', 'B', 'C']) await makeItem(item(l));
  });

  // ── The shared vectors, through the real triggers ─────────────────────────

  describe('shared vectors (docs/stock-vectors.json)', () => {
    for (const c of vectors.cases) {
      it(c.name, async () => {
        // The starting van, loaded the way stock arrives: a posted IN.
        const load = await header('IN');
        for (const [key, qtyMilli] of Object.entries(c.start)) {
          const [letter, pool] = key.split('|');
          await line(load, 'IN', { item: item(letter), baseQty: qtyMilli / 1000, pool, to: VAN });
        }
        for (const d of c.docs) {
          const v = await header(d.kind);
          const side = d.kind === 'SALE' ? { from: VAN } : { to: VAN };
          for (const l of d.lines) {
            // A bonus line is its unit's goods; the server resolves free:<id> to the unit.
            await line(v, d.kind, { item: item(l.item), baseQty: l.qty * l.factor, pool: l.pool, ...side });
          }
          for (const g of d.gifts ?? []) {
            await line(v, d.kind, { item: item(g.item), baseQty: g.qty, pool: '', ...side });
          }
        }
        for (const [key, expected] of Object.entries(c.expect)) {
          const [letter, pool] = key.split('|');
          expect(await milli(VAN, item(letter), pool)).toBe(expected);
          expect(await viewQty(VAN, item(letter), pool)).toBeCloseTo(expected / 1000, 3);
        }
        await expectVerified();
      });
    }
  });

  // ── Every way a voucher changes, and that the balance follows ─────────────

  it('a draft moves nothing; posting it moves it; unposting it puts it back', async () => {
    const v = await header('SALE', false);
    await line(v, 'SALE', { item: item('A'), baseQty: 4, from: VAN });
    expect(await milli(VAN, item('A'))).toBe(0);

    await q(`UPDATE voucher_headers SET is_posted = TRUE WHERE voucher_number = $1`, [v]);
    expect(await milli(VAN, item('A'))).toBe(-4000);

    await q(`UPDATE voucher_headers SET is_posted = FALSE WHERE voucher_number = $1`, [v]);
    expect(await milli(VAN, item('A'))).toBe(0);
    await expectVerified();
  });

  it('posting twice moves once', async () => {
    const v = await header('SALE', false);
    await line(v, 'SALE', { item: item('A'), baseQty: 4, from: VAN });
    await q(`UPDATE voucher_headers SET is_posted = TRUE WHERE voucher_number = $1`, [v]);
    await q(`UPDATE voucher_headers SET is_posted = TRUE WHERE voucher_number = $1`, [v]);
    expect(await milli(VAN, item('A'))).toBe(-4000);
  });

  it('a transfer moves both stores in one line', async () => {
    const v = await header('TRANSFER');
    await line(v, 'TRANSFER', { item: item('A'), baseQty: 12, from: DEPOT, to: VAN });
    expect(await milli(DEPOT, item('A'))).toBe(-12000);
    expect(await milli(VAN, item('A'))).toBe(12000);
    await expectVerified();
  });

  it('editing a posted quantity moves only the difference', async () => {
    const v = await header('SALE');
    const id = await line(v, 'SALE', { item: item('A'), baseQty: 4, from: VAN });
    await q(`UPDATE voucher_transactions SET item_qty = 6 WHERE id = $1`, [id]);
    expect(await milli(VAN, item('A'))).toBe(-6000);
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE txn_id = $1`, [id]);
    expect(n).toBe(2); // the sale, then −2 more — never a reversal and a re-apply
    await expectVerified();
  });

  it('moving a line to another pool moves the stock between the pools', async () => {
    const v = await header('SALE');
    const id = await line(v, 'SALE', { item: item('A'), baseQty: 3, pool: 'RED', from: VAN });
    await q(`UPDATE voucher_transactions SET stock_unit_code = 'BLUE' WHERE id = $1`, [id]);
    expect(await milli(VAN, item('A'), 'RED')).toBe(0);
    expect(await milli(VAN, item('A'), 'BLUE')).toBe(-3000);
    await expectVerified();
  });

  it('moving a line to another store moves the stock between the stores', async () => {
    const v = await header('SALE');
    const id = await line(v, 'SALE', { item: item('A'), baseQty: 3, from: VAN });
    await q(`UPDATE voucher_transactions SET from_store_number = $2, store_number = $2 WHERE id = $1`, [id, DEPOT]);
    expect(await milli(VAN, item('A'))).toBe(0);
    expect(await milli(DEPOT, item('A'))).toBe(-3000);
  });

  it('recording a return against a line changes no stock', async () => {
    const v = await header('SALE');
    const id = await line(v, 'SALE', { item: item('A'), baseQty: 5, from: VAN });
    await q(`UPDATE voucher_transactions SET qty_returned = qty_returned + 2 WHERE id = $1`, [id]);
    expect(await milli(VAN, item('A'))).toBe(-5000);
  });

  it('deleting a posted voucher takes its movement back out', async () => {
    const v = await header('SALE');
    await line(v, 'SALE', { item: item('A'), baseQty: 5, from: VAN });
    // The header delete cascades to the lines, as the ERP's voided-order path does.
    await q(`DELETE FROM voucher_headers WHERE voucher_number = $1`, [v]);
    expect(await milli(VAN, item('A'))).toBe(0);
    await expectVerified();
  });

  it('a raw insert — how the ERP mirror writes — is covered too', async () => {
    // mirrorMovement saves the header, then the line, straight through TypeORM:
    // no service method, no event. The trigger is what makes that safe.
    const v = `${P}-ERP-MV-1`;
    await q(
      `INSERT INTO voucher_headers (voucher_number, trans_kind, user_code, in_date, is_posted)
       VALUES ($1,'IN',$2, now(), TRUE)`,
      [v, USER_CODE],
    );
    await line(v, 'IN', { item: item('B'), baseQty: 7, to: VAN });
    expect(await viewQty(VAN, item('B'))).toBe(7);
  });

  it('verify finds a writer that went around the triggers', async () => {
    await q(`ALTER TABLE voucher_transactions DISABLE TRIGGER stock_line_ins`);
    try {
      const v = await header('IN');
      await line(v, 'IN', { item: item('C'), baseQty: 9, to: VAN });
    } finally {
      await q(`ALTER TABLE voucher_transactions ENABLE TRIGGER stock_line_ins`);
    }
    const { differences } = await ledger().verify();
    expect(differences.filter((d) => d.storeNumber === VAN)).toEqual([
      { storeNumber: VAN, itemNumber: item('C'), stockUnitCode: '', ledgerMilli: 0, replayMilli: 9000 },
    ]);
  });

  // ── The stock card ─────────────────────────────────────────────────────────

  it('the stock card lists every movement, newest first, each with the balance after it', async () => {
    const load = await header('IN');
    await line(load, 'IN', { item: item('A'), baseQty: 10, to: VAN });
    const sale = await header('SALE');
    await line(sale, 'SALE', { item: item('A'), baseQty: 4, from: VAN });
    const ret = await header('RETURN');
    await line(ret, 'RETURN', { item: item('A'), baseQty: 1, to: VAN });

    const card = await ledger().card({ store: VAN, itemNumber: item('A') });
    expect(card.balanceMilli).toBe(7000);
    expect(card.rows.map((r) => [r.voucherNumber, r.qtyMilli, r.balanceMilli, r.transKind])).toEqual([
      [ret, 1000, 7000, 'RETURN'],
      [sale, -4000, 6000, 'SALE'],
      [load, 10000, 10000, 'IN'],
    ]);
  });

  it('paging the stock card backwards keeps each running balance right', async () => {
    for (let i = 0; i < 3; i++) {
      const v = await header('IN');
      await line(v, 'IN', { item: item('A'), baseQty: 1, to: VAN });
    }
    const first = await ledger().card({ store: VAN, itemNumber: item('A'), limit: 2 });
    expect(first.rows.map((r) => r.balanceMilli)).toEqual([3000, 2000]);
    const older = await ledger().card({
      store: VAN, itemNumber: item('A'), limit: 2, beforeSeq: first.nextBeforeSeq!,
    });
    expect(older.rows.map((r) => r.balanceMilli)).toEqual([1000]);
    expect(older.nextBeforeSeq).toBeNull();
  });

  // ── The handset's snapshot ─────────────────────────────────────────────────

  describe('van-stock snapshot for a handset', () => {
    async function makeRep(): Promise<string> {
      const [rep] = await q(
        `INSERT INTO reps (name_ar, van_id) VALUES ($1, (SELECT id FROM warehouses WHERE wh_number = $2))
         RETURNING id`,
        [`${P} rep`, VAN],
      );
      return rep.id as string;
    }
    function vanStock(): VanStockService {
      const svc = Object.create(VanStockService.prototype) as Record<string, unknown>;
      svc.stock = ds.getRepository('VanStock');
      svc.reps = ds.getRepository('Rep');
      return svc as unknown as VanStockService;
    }
    /** An uploaded handset document, promoted (or not) to a posted voucher. */
    async function uploaded(ref: string, posted: boolean): Promise<string> {
      const v = await header('SALE', posted);
      await line(v, 'SALE', { item: item('A'), baseQty: 2, from: VAN });
      await q(
        `INSERT INTO voucher_inbox (type, client_ref, payload, status, assigned_number)
         VALUES ('VOUCHER', $1, '{}'::jsonb, $3, $2)`,
        [ref, v, posted ? 'posted' : 'pending'],
      );
      return v;
    }

    it('returns the balance exactly, in thousandths', async () => {
      const repId = await makeRep();
      const v = await header('IN');
      await line(v, 'IN', { item: item('A'), baseQty: 2.5, to: VAN });
      const snap = await vanStock().snapshot(repId, []);
      const row = snap.rows.find((r) => r.sku === item('A'));
      expect(row?.quantityMilli).toBe(2500);
      expect(row?.quantity).toBe(2.5);
    });

    it('says which pending documents the balance already contains', async () => {
      const repId = await makeRep();
      await uploaded(`${P}-ref-in`, true);
      await uploaded(`${P}-ref-waiting`, false);
      const snap = await vanStock().snapshot(repId, [
        { ref: `${P}-ref-in` },
        { ref: `${P}-ref-waiting` },
        { ref: `${P}-ref-never-uploaded` },
      ]);
      expect(snap.applied).toEqual([`${P}-ref-in`]);
    });

    it('matches a server-issued number when there is no inbox row', async () => {
      // An approved request: the server created the voucher itself.
      const repId = await makeRep();
      const v = await header('SALE');
      await line(v, 'SALE', { item: item('A'), baseQty: 1, from: VAN });
      const draft = await header('SALE', false);
      const snap = await vanStock().snapshot(repId, [
        { ref: `${P}-approved`, number: v },
        { ref: `${P}-left-a-draft`, number: draft },
      ]);
      expect(snap.applied).toEqual([`${P}-approved`]);
    });
  });
});
