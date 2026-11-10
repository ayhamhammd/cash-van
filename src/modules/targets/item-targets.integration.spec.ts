/**
 * Real-DB: item targets.
 *
 * Achievement = posted SALE lines − posted RETURN lines of the item, in the
 * month, for the rep whose login is the voucher's user_code — checked against
 * vouchers written the way each path writes them:
 *  - a van sale in cartons (item_qty already in pieces, unit_base_qty 12);
 *  - an office invoice made from the rep's ORDER (ERP-, a carton SKU recorded
 *    as qty 1 with unit_base_qty 1 → 12 pieces);
 *  - a van return, and an approved delivery return (ERP-RET-) against him;
 *  - another rep's sale, an unposted sale, and sales either side of the month,
 *    none of which count.
 * QTY in the item's base unit; AMOUNT with and without tax per the setting.
 * Plus the PUT's replace semantics and validation, the switch, the report's
 * enrichment, and the migration up/down.
 *
 * Skipped unless DB_NAME points at a database with the schema applied. Creates
 * and removes everything under ZZIT.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ItemTargets1728740000000 } from '../../database/migrations/1728740000000-ItemTargets';
import { SettingsService } from '../settings/settings.service';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { ItemTargetsService } from './item-targets.service';
import { TargetsService } from './targets.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZIT';

run('item targets (real DB)', () => {
  let ds: DataSource;
  let svc: ItemTargetsService;
  let repA = '';
  let repB = '';
  let before = { on: false, tax: true };
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);

  async function purge() {
    await q(`DELETE FROM sales_item_targets WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_headers WHERE voucher_number LIKE $1 OR voucher_number LIKE $2`, [`${P}%`, `ERP-%${P}%`]);
    await q(`DELETE FROM item_units WHERE erp_sku_code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
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
    [{ on: before.on, tax: before.tax }] = await q(
      `SELECT item_targets_enabled AS on, targets_include_tax AS tax FROM app_settings WHERE id = 1`,
    );
    await q(`UPDATE app_settings SET item_targets_enabled = true, targets_include_tax = true WHERE id = 1`);
    await q(
      `INSERT INTO transaction_kinds (trans_kind, trans_name, sign) VALUES ('SALE','بيع',-1), ('RETURN','مرتجع',1)
       ON CONFLICT (trans_kind) DO NOTHING`,
    );
    await q(`INSERT INTO units (code, name_ar, name_en) VALUES ('PCE', 'قطعة', 'piece') ON CONFLICT (code) DO NOTHING`);
    for (const c of ['A', 'B']) {
      const [{ id: uid }] = await q<{ id: string }>(
        `INSERT INTO users (user_number, name, password_hash, user_type, role) VALUES ($1, $1, 'x', 'SALES', 'viewer') RETURNING id`,
        [`${P}${c}`],
      );
      const [{ id }] = await q<{ id: string }>(`INSERT INTO reps (code, name_ar, user_id) VALUES ($1, $2, $3) RETURNING id`, [
        `${P}${c}`,
        `مندوب ${c}`,
        uid,
      ]);
      if (c === 'A') repA = id;
      else repB = id;
    }
    const [{ id: water }] = await q<{ id: string }>(
      `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar, name_en, price, unit_of_measure)
       VALUES ($1, 'Water', $1, $1, 'ماء', 'Water', 1000, 'PCE') RETURNING id`,
      [`${P}W`],
    );
    await q(
      `INSERT INTO item_cart (item_number, item_name, barcode, sku, name_ar, name_en, price, unit_of_measure)
       VALUES ($1, 'Juice', $1, $1, 'عصير', 'Juice', 2000, 'PCE')`,
      [`${P}J`],
    );
    const [{ id: carton }] = await q<{ id: string }>(
      `INSERT INTO item_units (item_id, unit_id, qty, erp_sku_code, barcode)
       VALUES ($1, (SELECT id FROM units WHERE code = 'PCE'), 12, $2, $2) RETURNING id`,
      [water, `${P}W-CTN`],
    );

    // Vouchers, each as its own path writes it. Month under test: 2026-11.
    const voucher = async (
      n: string,
      kind: 'SALE' | 'RETURN',
      rep: 'A' | 'B',
      date: string,
      line: { qty: number; ofUnit: number; base: number; unitId: string | null; total: number; net: number },
      posted = true,
    ) => {
      await q(
        `INSERT INTO voucher_headers (voucher_number, user_code, trans_kind, is_posted, in_date, total, net_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [n, `${P}${rep}`, kind, posted, date, line.total, line.net],
      );
      await q(
        `INSERT INTO voucher_transactions (voucher_number, item_number, item_name, trans_kind, item_qty, qty_of_unit,
                                           unit_base_qty, item_unit_id, total, net_total)
         VALUES ($1, $2, 'Water', $3, $4, $5, $6, $7, $8, $9)`,
        [n, `${P}W`, kind, line.qty, line.ofUnit, line.base, line.unitId, line.total, line.net],
      );
    };
    // A van sale of 2 cartons: item_qty is already 24 pieces.
    await voucher(`${P}-S1`, 'SALE', 'A', '2026-11-05T10:00:00Z', { qty: 24, ofUnit: 2, base: 12, unitId: carton, total: 24, net: 27.84 });
    // The office invoiced his ORDER: a carton SKU, recorded as 1 with unit_base_qty 1 → 12 pieces.
    await voucher(`ERP-${P}-INV-1`, 'SALE', 'A', '2026-11-10T10:00:00Z', { qty: 1, ofUnit: 1, base: 1, unitId: carton, total: 12, net: 13.92 });
    // A van return of 2 pieces, and an approved delivery return of 1 piece.
    await voucher(`${P}-R1`, 'RETURN', 'A', '2026-11-12T10:00:00Z', { qty: 2, ofUnit: 2, base: 1, unitId: null, total: 2, net: 2.32 });
    await voucher(`ERP-RET-${P}-CN-1`, 'RETURN', 'A', '2026-11-20T10:00:00Z', { qty: 1, ofUnit: 1, base: 1, unitId: null, total: 1, net: 1.16 });
    // Not counted: another rep, unposted, the months either side.
    await voucher(`${P}-SB`, 'SALE', 'B', '2026-11-05T10:00:00Z', { qty: 100, ofUnit: 100, base: 1, unitId: null, total: 100, net: 116 });
    await voucher(`${P}-SU`, 'SALE', 'A', '2026-11-06T10:00:00Z', { qty: 7, ofUnit: 7, base: 1, unitId: null, total: 7, net: 8.12 }, false);
    await voucher(`${P}-SP`, 'SALE', 'A', '2026-10-31T12:00:00Z', { qty: 50, ofUnit: 50, base: 1, unitId: null, total: 50, net: 58 });
    await voucher(`${P}-SN`, 'SALE', 'A', '2026-12-01T09:00:00Z', { qty: 60, ofUnit: 60, base: 1, unitId: null, total: 60, net: 69.6 });

    svc = new ItemTargetsService(ds, new SettingsService(ds.getRepository(AppSettings), {} as never, {} as never));
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`UPDATE app_settings SET item_targets_enabled = $1, targets_include_tax = $2 WHERE id = 1`, [before.on, before.tax]);
    await purge();
    await ds.destroy();
  });

  it('QTY: sales − returns, in pieces (cartons converted), only his, only this month', async () => {
    const out = await svc.replace({ repId: repA, year: 2026, month: 11, lines: [{ itemNumber: `${P}W`, metric: 'QTY', targetQty: 66 }] }, null);
    expect(out.items).toEqual([
      expect.objectContaining({
        repId: repA,
        repCode: `${P}A`,
        itemNumber: `${P}W`,
        itemNameAr: 'ماء',
        itemNameEn: 'Water',
        unitNameAr: 'قطعة',
        unitNameEn: 'piece',
        metric: 'QTY',
        targetQty: 66,
        targetFils: null,
        // 24 + 12 − 2 − 1
        achievedQty: 33,
        achievedFils: null,
        pct: 50,
      }),
    ]);
  });

  it('AMOUNT: with tax while targets include tax, without when they do not', async () => {
    await svc.replace({ repId: repA, year: 2026, month: 11, lines: [{ itemNumber: `${P}W`, metric: 'AMOUNT', targetFils: 76560 }] }, null);
    let [line] = (await svc.list(2026, 11, repA)).items;
    // 27.840 + 13.920 − 2.320 − 1.160
    expect(line).toMatchObject({ metric: 'AMOUNT', targetFils: 76560, achievedFils: 38280, achievedQty: null, pct: 50 });
    await q(`UPDATE app_settings SET targets_include_tax = false WHERE id = 1`);
    [line] = (await svc.list(2026, 11, repA)).items;
    // 24 + 12 − 2 − 1
    expect(line).toMatchObject({ achievedFils: 33000, pct: 43 });
    await q(`UPDATE app_settings SET targets_include_tax = true WHERE id = 1`);
  });

  it('the other rep counts only his own sale', async () => {
    await svc.replace({ repId: repB, year: 2026, month: 11, lines: [{ itemNumber: `${P}W`, metric: 'QTY', targetQty: 200 }] }, null);
    expect((await svc.list(2026, 11, repB)).items[0]).toMatchObject({ achievedQty: 100, pct: 50 });
  });

  it('PUT replaces: lines left out are deleted, the rest upserted; validation names the problem', async () => {
    await svc.replace(
      {
        repId: repA,
        year: 2026,
        month: 11,
        lines: [
          { itemNumber: `${P}W`, metric: 'QTY', targetQty: 10.125, notes: 'cartons please' },
          { itemNumber: `${P}J`, metric: 'AMOUNT', targetFils: 5000 },
        ],
      },
      null,
    );
    expect((await svc.list(2026, 11, repA)).items.map((i) => [i.itemNumber, i.metric])).toEqual([
      [`${P}J`, 'AMOUNT'],
      [`${P}W`, 'QTY'],
    ]);
    const out = await svc.replace({ repId: repA, year: 2026, month: 11, lines: [{ itemNumber: `${P}J`, metric: 'QTY', targetQty: 3 }] }, null);
    expect(out.items.map((i) => [i.itemNumber, i.metric, i.targetQty])).toEqual([[`${P}J`, 'QTY', 3]]);
    // B's month is untouched by A's replace.
    expect((await svc.list(2026, 11, repB)).items).toHaveLength(1);

    const bad = (lines: unknown[]) =>
      svc.replace({ repId: repA, year: 2026, month: 11, lines: lines as never }, null).catch((e: unknown) => e);
    for (const lines of [
      [{ itemNumber: `${P}NOPE`, metric: 'QTY', targetQty: 1 }],
      [{ itemNumber: `${P}W`, metric: 'QTY', targetFils: 100 }],
      [{ itemNumber: `${P}W`, metric: 'AMOUNT', targetFils: 10.5 }],
      [{ itemNumber: `${P}W`, metric: 'QTY', targetQty: 1.2345 }],
    ]) {
      const e = await bad(lines);
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'ITEM_TARGET_INVALID' });
    }
    // A refused PUT changed nothing.
    expect((await svc.list(2026, 11, repA)).items.map((i) => i.itemNumber)).toEqual([`${P}J`]);
    // The check constraint backs the service up.
    await expect(
      q(`INSERT INTO sales_item_targets (rep_id, year, month, item_number, metric, target_qty, target_fils)
         VALUES ($1, 2026, 12, $2, 'QTY', 1, 5)`, [repA, `${P}W`]),
    ).rejects.toThrow();
  });

  it('the monthly report carries itemTargets while on, omits them while off', async () => {
    const targets = new TargetsService(ds, ds.getRepository('SalesTarget') as never, { erpSalesBySalesman: async () => 'off' } as never, svc);
    const rowA = (await targets.list(2026, 11, [repA]))[0];
    expect(rowA.itemTargets?.map((i) => i.itemNumber)).toEqual([`${P}J`]);
    const me = await targets.getForRep(repA, 2026, 11);
    expect(me.itemTargets).toHaveLength(1);
    await q(`UPDATE app_settings SET item_targets_enabled = false WHERE id = 1`);
    expect((await targets.list(2026, 11, [repA]))[0]).not.toHaveProperty('itemTargets');
    await q(`UPDATE app_settings SET item_targets_enabled = true WHERE id = 1`);
  });

  it('off: GET is empty, PUT and DELETE are 403, the stored rows stay', async () => {
    const id = (await svc.list(2026, 11, repA)).items[0].id;
    await q(`UPDATE app_settings SET item_targets_enabled = false WHERE id = 1`);
    expect(await svc.list(2026, 11, repA)).toEqual({ items: [] });
    await expect(svc.replace({ repId: repA, year: 2026, month: 11, lines: [] }, null)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove(id)).rejects.toMatchObject({ response: { code: 'FEATURE_DISABLED' } });
    expect(await q(`SELECT 1 FROM sales_item_targets WHERE id = $1`, [id])).toHaveLength(1);
    await q(`UPDATE app_settings SET item_targets_enabled = true WHERE id = 1`);
    expect(await svc.remove(id)).toEqual({ deleted: true });
  });

  it('the migration comes off and back cleanly (rolled back)', async () => {
    const m = new ItemTargets1728740000000();
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await m.down(qr);
      expect(await qr.query(`SELECT to_regclass('sales_item_targets') AS t`)).toEqual([{ t: null }]);
      expect(await qr.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'item_targets_enabled'`)).toEqual([]);
      await m.up(qr);
      expect(await qr.query(`SELECT to_regclass('sales_item_targets')::text AS t`)).toEqual([{ t: 'sales_item_targets' }]);
      expect((await qr.query(`SELECT item_targets_enabled AS on FROM app_settings WHERE id = 1`))[0].on).toBe(false);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });
});
