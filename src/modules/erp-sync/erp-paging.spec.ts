import { ErpHttpClient } from './erp-http.client';

/**
 * Paging, against a server that gives you fewer rows than you asked for.
 *
 * THE FAILURE THIS PINS. The ERP caps pageSize at 100 and does not say so — ask
 * for 200 and you are handed 100, with a `total` that still describes the whole
 * set. Callers asked for 200 and then measured progress by the size they had
 * ASKED for: `page * 200 >= total` called the job done after fetching half of
 * it. Roughly half the ERP's stock never reached this server; the items in the
 * missing half kept whatever figure they already had, and once a reconciliation
 * read "absent from the snapshot" as "the ERP holds none", that half was zeroed.
 *
 * So these tests do the one thing that reproduces it: a stub that returns FEWER
 * rows per page than requested, while reporting the true total.
 */
describe('ErpHttpClient.listAll (pages by what it received, not what it asked for)', () => {
  /** A server holding `total` rows and handing back at most `serverPageSize`. */
  function stub(total: number, serverPageSize = 100) {
    const calls: Array<{ page: number; pageSize: number }> = [];
    const client = Object.create(ErpHttpClient.prototype) as ErpHttpClient;
    const inner = client as unknown as Record<string, unknown>;
    inner.logger = { log: () => undefined, warn: () => undefined };
    inner.list = jest.fn(
      async (_path: string, q: { page: number; pageSize: number }) => {
        calls.push({ page: q.page, pageSize: q.pageSize });
        // The cap the real ERP applies, silently.
        const size = Math.min(serverPageSize, q.pageSize);
        const offset = (q.page - 1) * size;
        const data = Array.from(
          { length: Math.max(0, Math.min(size, total - offset)) },
          (_, i) => ({ id: offset + i }),
        );
        return { data, total };
      },
    );
    return { client: client as ErpHttpClient, calls };
  }

  const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

  it('fetches every row when the server pages smaller than requested', async () => {
    const { client } = stub(250);
    const res = await client.listAll<{ id: number }>('van/stock');
    // The old loop stopped at 200 of these — this is the whole bug in one number.
    expect(res.data).toHaveLength(250);
    expect(ids(res.data)).toEqual(Array.from({ length: 250 }, (_, i) => i));
  });

  it('never asks for more than the server will give', async () => {
    const { client, calls } = stub(250);
    await client.listAll('van/stock');
    // Asking for 200 was what made the mismatch invisible: it is not an error,
    // it is quietly ignored, and the caller then believes it has 200 rows.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.pageSize <= 100)).toBe(true);
  });

  it('loses nothing at an exact page boundary', async () => {
    // 200 rows at 100 a page: the page after the last full one is empty, and a
    // loop that trusts a full page to mean "more" must still terminate.
    const { client } = stub(200);
    const res = await client.listAll<{ id: number }>('van/stock');
    expect(res.data).toHaveLength(200);
  });

  it('handles a single short page', async () => {
    const { client } = stub(7);
    expect(await client.listAll('van/stock').then((r) => r.data)).toHaveLength(7);
  });

  it('returns nothing, and asks once, for an empty set', async () => {
    const { client, calls } = stub(0);
    const res = await client.listAll('van/stock');
    expect(res.data).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('stops on an empty page even when the total is a lie', async () => {
    // A server that over-reports `total` must not spin this for ever — the rows
    // running out is the real end of the list.
    const { client } = stub(30);
    (client as unknown as { list: jest.Mock }).list = jest.fn(
      async (_p: string, q: { page: number }) => ({
        data: q.page === 1 ? [{ id: 1 }] : [],
        total: 9999,
      }),
    );
    const res = await client.listAll('van/stock');
    expect(res.data).toHaveLength(1);
  });

  it('gives up at the page cap rather than looping for ever', async () => {
    // A server that reports a total it never delivers.
    const client = Object.create(ErpHttpClient.prototype) as ErpHttpClient;
    const inner2 = client as unknown as Record<string, unknown>;
    inner2.logger = { log: () => undefined, warn: () => undefined };
    inner2.list = jest.fn(async () => ({
      data: [{ id: 1 }],
      total: 1_000_000,
    }));
    const res = await client.listAll('van/stock', {}, { maxPages: 5 });
    expect(res.data).toHaveLength(5);
    expect((client as unknown as { list: jest.Mock }).list).toHaveBeenCalledTimes(5);
  });

  it('passes the caller’s own filters through on every page', async () => {
    const { client, calls } = stub(250);
    await client.listAll('stock-movements', { warehouseCode: 'V-1' });
    expect(calls).toHaveLength(3);
    const listMock = (client as unknown as { list: jest.Mock }).list;
    for (const call of listMock.mock.calls) {
      expect(call[1]).toMatchObject({ warehouseCode: 'V-1' });
    }
  });
});
