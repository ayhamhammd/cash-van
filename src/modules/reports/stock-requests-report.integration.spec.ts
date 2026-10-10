/**
 * Real-DB tests for the stock requests & approvals report.
 *
 * The office reads it for three questions: what did each salesman ask for, who
 * decided it, and did the goods actually arrive. Each filter answers one of
 * them, and the summary has to keep describing the whole selection while the
 * table is narrowed to one status — otherwise ticking "received" hides how
 * many are still waiting.
 *
 * Every call is scoped to this file's two salesmen, so whatever else the
 * database holds cannot change the answers.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { DataSource } from 'typeorm';

import { ReportsService } from './reports.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZSRR';

run('stock requests report (real DB)', () => {
  let ds: DataSource;
  let reports: ReportsService;
  let samiId = '';
  let lailaId = '';
  let bossId = '';
  let clerkId = '';
  let both: string[] = [];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  async function purge() {
    await q(
      `DELETE FROM stock_request_items WHERE request_id IN
         (SELECT id FROM stock_requests WHERE request_number LIKE $1)`,
      [`${P}%`],
    );
    await q(`DELETE FROM stock_requests WHERE request_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM reps WHERE code LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE user_number LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM warehouses WHERE wh_number LIKE $1`, [`${P}%`]);
  }

  async function makeUser(code: string, name: string, type: string) {
    const [u] = await q(
      `INSERT INTO users (user_number, name, password_hash, user_type) VALUES ($1,$2,'x',$3) RETURNING id`,
      [code, name, type],
    );
    return u.id as string;
  }

  async function makeRep(code: string, name: string) {
    const userId = await makeUser(code, name, 'SALES');
    const [r] = await q(
      `INSERT INTO reps (user_id, code, name_ar, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
      [userId, code, name],
    );
    return { repId: r.id as string, userId };
  }

  async function makeRequest(
    n: string,
    rep: { repId: string; userId: string },
    opts: {
      status: string;
      createdAt: string;
      reviewer?: string;
      /** Defaults to the reviewer for an approved or received request. */
      approver?: string;
      deleted?: boolean;
      lines?: Array<{ item: string; asked: number; granted: number | null }>;
    },
  ) {
    const [r] = await q(
      `INSERT INTO stock_requests
         (request_number, status, requester_user, rep_id, van_store_number, source_store_number,
          reviewer_user, created_at, decided_at, received_at, deleted_at, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, 'V1', $5, $6, $7::timestamptz,
               CASE WHEN $6::uuid IS NULL THEN NULL ELSE $7::timestamptz + INTERVAL '1 hour' END,
               CASE WHEN $2 = 'received' THEN $7::timestamptz + INTERVAL '5 hours' END,
               CASE WHEN $8 THEN now() END,
               $9::uuid,
               CASE WHEN $9::uuid IS NULL THEN NULL ELSE $7::timestamptz + INTERVAL '30 minutes' END)
       RETURNING id`,
      [
        `${P}-${n}`,
        opts.status,
        rep.userId,
        rep.repId,
        opts.reviewer ? `${P}-W` : null,
        opts.reviewer ?? null,
        opts.createdAt,
        opts.deleted ?? false,
        opts.approver ??
          (opts.status === 'approved' || opts.status === 'received' ? opts.reviewer ?? null : null),
      ],
    );
    for (const l of opts.lines ?? [{ item: 'A', asked: 1, granted: opts.reviewer ? 1 : null }]) {
      await q(
        `INSERT INTO stock_request_items
           (request_id, item_number, item_name, qty_of_unit, base_qty, approved_base_qty)
         VALUES ($1, $2, $2, $3, $3, $4)`,
        [r.id, `${P}-${l.item}`, l.asked, l.granted],
      );
    }
  }

  const numbers = (res: { items: Array<{ requestNumber: string }> }) =>
    res.items.map((i) => i.requestNumber.replace(`${P}-`, ''));

  const march = { dateFrom: '2026-03-01', dateTo: '2026-03-31' };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      entities: [],
      synchronize: false,
    });
    await ds.initialize();
    reports = new ReportsService(ds, null as never, null as never, null as never);

    await purge();
    await q(`INSERT INTO warehouses (wh_number, wh_name) VALUES ($1, 'Main ZZ')`, [`${P}-W`]);
    const sami = await makeRep(`${P}-SAMI`, 'Sami');
    const laila = await makeRep(`${P}-LAILA`, 'Laila');
    samiId = sami.repId;
    lailaId = laila.repId;
    both = [samiId, lailaId];
    bossId = await makeUser(`${P}-BOSS`, 'Boss', 'ADMIN');
    clerkId = await makeUser(`${P}-CLERK`, 'Clerk', 'MANAGER');

    await makeRequest('R1', sami, {
      status: 'received', reviewer: bossId, createdAt: '2026-03-10 12:00+03',
      lines: [{ item: 'A', asked: 10, granted: 10 }],
    });
    await makeRequest('R2', sami, {
      status: 'approved', reviewer: bossId, createdAt: '2026-03-11 12:00+03',
      lines: [{ item: 'A', asked: 5, granted: 3 }, { item: 'B', asked: 2, granted: 0 }],
    });
    await makeRequest('R3', laila, { status: 'rejected', reviewer: clerkId, createdAt: '2026-03-12 12:00+03' });
    await makeRequest('R4', laila, { status: 'pending', createdAt: '2026-03-13 12:00+03' });
    // The last day of the range, late: dateTo must include its whole day.
    await makeRequest('R5', sami, { status: 'received', reviewer: clerkId, createdAt: '2026-03-31 22:00+03' });
    // Cleared from the queue — and from the report.
    await makeRequest('R6', sami, {
      status: 'rejected', reviewer: bossId, createdAt: '2026-03-14 12:00+03', deleted: true,
    });
    // Approved by Boss, then taken back by Clerk before the goods arrived.
    await makeRequest('R8', sami, {
      status: 'rejected', approver: bossId, reviewer: clerkId, createdAt: '2026-03-15 12:00+03',
      lines: [{ item: 'A', asked: 4, granted: 4 }],
    });
    // Outside the range.
    await makeRequest('R7', sami, { status: 'pending', createdAt: '2026-04-01 12:00+03' });
  }, 120_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  it('lists the range newest first, without deleted or out-of-range requests', async () => {
    const res = await reports.stockRequests({ ...march }, both);
    expect(numbers(res)).toEqual(['R5', 'R8', 'R4', 'R3', 'R2', 'R1']);
    expect(res.total).toBe(6);
  });

  it('names the salesman, the approver and the source warehouse', async () => {
    const res = await reports.stockRequests({ ...march }, both);
    const r1 = res.items.find((i) => i.requestNumber === `${P}-R1`)!;
    expect(r1).toMatchObject({
      repName: 'Sami',
      approverName: 'Boss',
      reviewerName: 'Boss',
      sourceStoreName: 'Main ZZ',
      status: 'received',
    });
    expect(r1.receivedAt).not.toBeNull();
    const r4 = res.items.find((i) => i.requestNumber === `${P}-R4`)!;
    expect(r4.reviewerName).toBeNull();
    expect(r4.approverName).toBeNull();
    expect(r4.decidedAt).toBeNull();
  });

  it('a request rejected after approval keeps its approver beside its rejecter', async () => {
    const res = await reports.stockRequests({ ...march }, both);
    const r8 = res.items.find((i) => i.requestNumber === `${P}-R8`)!;
    expect(r8).toMatchObject({ status: 'rejected', approverName: 'Boss', reviewerName: 'Clerk' });
    expect(r8.approvedAt).not.toBeNull();
    // Rejected straight from pending: nobody approved it.
    const r3 = res.items.find((i) => i.requestNumber === `${P}-R3`)!;
    expect(r3).toMatchObject({ approverName: null, reviewerName: 'Clerk' });
  });

  it('filters by salesman', async () => {
    expect(numbers(await reports.stockRequests({ ...march, repId: samiId }, both))).toEqual([
      'R5', 'R8', 'R2', 'R1',
    ]);
    expect(numbers(await reports.stockRequests({ ...march, repId: lailaId }, both))).toEqual([
      'R4', 'R3',
    ]);
  });

  it('filters by the person who approved or rejected', async () => {
    // R8 belongs to both: Boss approved it, Clerk took it back.
    expect(numbers(await reports.stockRequests({ ...march, reviewerId: bossId }, both))).toEqual([
      'R8', 'R2', 'R1',
    ]);
    expect(numbers(await reports.stockRequests({ ...march, reviewerId: clerkId }, both))).toEqual([
      'R5', 'R8', 'R3',
    ]);
  });

  it('received=yes is what arrived; received=no is approved and still waiting', async () => {
    expect(numbers(await reports.stockRequests({ ...march, received: 'yes' }, both))).toEqual([
      'R5', 'R1',
    ]);
    expect(numbers(await reports.stockRequests({ ...march, received: 'no' }, both))).toEqual(['R2']);
  });

  it('combines filters', async () => {
    const res = await reports.stockRequests(
      { ...march, repId: samiId, reviewerId: bossId, received: 'no' },
      both,
    );
    expect(numbers(res)).toEqual(['R2']);
    expect(res.total).toBe(1);
  });

  it('the summary describes the selection, not the received/status narrowing', async () => {
    const res = await reports.stockRequests({ ...march, received: 'yes' }, both);
    expect(res.total).toBe(2);
    expect(res.summary).toEqual({
      total: 6, pending: 1, approved: 1, received: 2, rejected: 2, cancelled: 0,
    });
    const sami = await reports.stockRequests({ ...march, repId: samiId, status: 'approved' }, both);
    expect(sami.summary).toMatchObject({ total: 4, approved: 1, received: 2, rejected: 1, pending: 0 });
  });

  it('carries each request\'s lines, asked against granted', async () => {
    const res = await reports.stockRequests({ ...march, repId: samiId }, both);
    const r2 = res.items.find((i) => i.requestNumber === `${P}-R2`)!;
    expect(r2.lines.map((l) => [l.itemNumber.replace(`${P}-`, ''), l.baseQty, l.approvedBaseQty])).toEqual([
      ['A', 5, 3],
      ['B', 2, 0],
    ]);
    const pending = (await reports.stockRequests({ ...march, repId: lailaId }, both)).items.find(
      (i) => i.requestNumber === `${P}-R4`,
    )!;
    expect(pending.lines[0].approvedBaseQty).toBeNull();
  });

  it('a scoped viewer sees only their salesmen, and only their approvers', async () => {
    const res = await reports.stockRequests({ ...march }, [lailaId]);
    expect(numbers(res)).toEqual(['R4', 'R3']);
    expect(res.reviewers.filter((r) => r.name === 'Boss' || r.name === 'Clerk')).toEqual([
      { id: clerkId, name: 'Clerk' },
    ]);
    // Asking for a salesman outside the scope returns nothing, not the scope.
    expect((await reports.stockRequests({ ...march, repId: samiId }, [lailaId])).total).toBe(0);
  });

  it('offers as approvers only people who have decided a visible request', async () => {
    const res = await reports.stockRequests({ ...march }, both);
    const names = res.reviewers.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Boss', 'Clerk']));
    expect(names).not.toContain('Sami');
    expect(names).not.toContain('Laila');
  });

  it('pages without losing the total', async () => {
    const page = await reports.stockRequests({ ...march, offset: 1, limit: 2 }, both);
    expect(numbers(page)).toEqual(['R8', 'R4']);
    expect(page.total).toBe(6);
  });
});
