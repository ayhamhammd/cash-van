/**
 * Real-DB: the Delivery & collection master switch.
 *
 *  - the migration turns it on only where delivery is in use (a mirrored run or
 *    a rep who delivers), off elsewhere;
 *  - off: the phone's lists are empty, a result it saved is still accepted (the
 *    proof sub-flag has no effect), the office's guard refuses; back on, the
 *    run is there again with the result.
 *
 * Skipped unless DB_NAME points at a database with the schema applied. Creates
 * and removes everything under ZZEN.
 */
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DeliveryEnabledFlag1728730000000 } from '../../database/migrations/1728730000000-DeliveryEnabledFlag';
import { ErpSyncCursor } from '../erp-sync/entities/erp-sync-cursor.entity';
import { Rep } from '../reps/entities/rep.entity';
import { SettingsService } from '../settings/settings.service';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveryFeatureGuard } from './delivery-feature.guard';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import { DeliveryProof } from './entities/delivery-proof.entity';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;
const P = 'ZZEN';

run('Delivery & collection switch (real DB)', () => {
  let ds: DataSource;
  let deliveries: DeliveriesService;
  let intake: DeliveryIntakeService;
  let mirror: DeliveryMirrorService;
  let repD = '';
  let before: { enabled: boolean; proof: boolean } = { enabled: true, proof: true };
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const setOn = (on: boolean) => q(`UPDATE app_settings SET delivery_enabled = $1 WHERE id = 1`, [on]);

  async function purge() {
    await q(`DELETE FROM erp_outbox WHERE ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM voucher_inbox WHERE client_ref LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM delivery_runs WHERE erp_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
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
    [{ enabled: before.enabled, proof: before.proof }] = await q(
      `SELECT delivery_enabled AS enabled, delivery_proof_required AS proof FROM app_settings WHERE id = 1`,
    );
    [{ id: repD }] = await q<{ id: string }>(
      `INSERT INTO reps (code, name_ar, kind) VALUES ($1, 'مندوب توصيل', 'DELIVERY') RETURNING id`,
      [`${P}D`],
    );
    const erp = { isEnabled: async () => true, getRun: jest.fn() };
    mirror = new DeliveryMirrorService(ds, erp as never, ds.getRepository(ErpSyncCursor), { emit: () => true } as never);
    deliveries = new DeliveriesService(
      ds,
      ds.getRepository(DeliveryRun),
      ds.getRepository(DeliveryStop),
      ds.getRepository(DeliveryStopLine),
      ds.getRepository(Rep),
      { locationMode: async () => 'FLAT' } as never,
      erp as never,
      mirror,
      ds.getRepository(DeliveryProof),
    );
    intake = new DeliveryIntakeService(
      ds,
      deliveries,
      mirror,
      { registerHandler: () => undefined, pushRefNow: async () => undefined } as never,
      { notifyManagers: async () => 0 } as never,
      {} as never,
    );
    await mirror.applyRun({
      id: `${P}-run`,
      runNumber: `${P}-DR`,
      runDate: '2026-11-10',
      status: 'OPEN',
      updatedAt: '2026-11-10T08:00:00.000Z',
      driver: { type: 'SALESMAN', salesmanCode: `${P}D` },
      items: [{ id: `${P}-item`, sequence: 1, status: 'LOADED', invoice: { id: `${P}-inv`, invoiceNumber: `${P}-INV`, totalAmount: 1 } }],
    });
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await q(`UPDATE app_settings SET delivery_enabled = $1, delivery_proof_required = $2 WHERE id = 1`, [
      before.enabled,
      before.proof,
    ]);
    await purge();
    await ds.destroy();
  });

  it('migration: on only where delivery is in use (rolled back — nothing else is touched)', async () => {
    const m = new DeliveryEnabledFlag1728730000000();
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const flag = async () => (await qr.query(`SELECT delivery_enabled AS on FROM app_settings WHERE id = 1`))[0].on;
      // An install that never used delivery.
      await qr.query(`DELETE FROM delivery_runs`);
      await qr.query(`UPDATE reps SET kind = 'SALES' WHERE kind <> 'SALES'`);
      await m.down(qr);
      await m.up(qr);
      expect(await flag()).toBe(false);
      // A rep who delivers.
      await qr.query(`UPDATE reps SET kind = 'BOTH' WHERE id = $1`, [repD]);
      await m.down(qr);
      await m.up(qr);
      expect(await flag()).toBe(true);
      // A mirrored run, with no delivery rep left.
      await qr.query(`UPDATE reps SET kind = 'SALES' WHERE id = $1`, [repD]);
      await qr.query(`INSERT INTO delivery_runs (erp_id, status) VALUES ($1, 'CLOSED')`, [`${P}-old`]);
      await m.down(qr);
      await m.up(qr);
      expect(await flag()).toBe(true);
      // A deleted delivery rep does not count.
      await qr.query(`DELETE FROM delivery_runs`);
      await qr.query(`UPDATE reps SET kind = 'DELIVERY', deleted_at = now() WHERE id = $1`, [repD]);
      await m.down(qr);
      await m.up(qr);
      expect(await flag()).toBe(false);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
    expect((await q(`SELECT kind FROM reps WHERE id = $1`, [repD]))[0]).toEqual({ kind: 'DELIVERY' });
  });

  it('off: the phone sees no runs and no history; the office guard refuses', async () => {
    await setOn(false);
    const actor = { repId: repD } as never;
    expect((await deliveries.mine(actor)).runs).toEqual([]);
    expect(await deliveries.history(actor, {})).toEqual({ items: [], total: 0 });
    const guard = new DeliveryFeatureGuard(
      new SettingsService(ds.getRepository(AppSettings), {} as never, {} as never),
      { getAllAndOverride: () => false } as never,
    );
    await expect(guard.canActivate({ getHandler: () => ({}), getClass: () => ({}) } as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('off: a result the phone saved is still accepted, proofs not demanded; back on, the run shows it', async () => {
    await q(`UPDATE app_settings SET delivery_proof_required = true WHERE id = 1`);
    const stopId = (await q<{ id: string }>(`SELECT id FROM delivery_stops WHERE erp_id = $1`, [`${P}-item`]))[0].id;
    const out = await intake.ingest(
      { clientRef: `${P}-ref`, stopId, outcome: 'DELIVERED', deliveredAt: '2026-11-10T10:00:00+03:00' } as never,
      { repId: repD } as never,
    );
    expect(out).toEqual({ status: 'accepted' });
    expect(await q(`SELECT kind FROM erp_outbox WHERE ref = $1`, [`${P}-ref`])).toEqual([{ kind: 'DELIVERY_RESULT' }]);

    await setOn(true);
    const mine = await deliveries.mine({ repId: repD } as never);
    const run = mine.runs.find((r) => r.erpId === `${P}-run`)!;
    expect(run.stops[0]).toMatchObject({ displayStatus: 'SENDING' });
    const guard = new DeliveryFeatureGuard(
      new SettingsService(ds.getRepository(AppSettings), {} as never, {} as never),
      { getAllAndOverride: () => false } as never,
    );
    expect(await guard.canActivate({ getHandler: () => ({}), getClass: () => ({}) } as never)).toBe(true);
  });
});
