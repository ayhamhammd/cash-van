import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import {
  DeliveryProofsService,
  MAX_PHOTOS_PER_STOP,
  checkProofFile,
  sniffImage,
} from './delivery-proofs.service';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(50)]);

describe('proof files', () => {
  it('reads the type from the bytes, not from what the phone claims', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('a photo is JPEG/PNG/WebP ≤ 3 MB; a signature a PNG ≤ 300 KB', () => {
    expect(checkProofFile('PHOTO', JPEG)).toEqual({ mime: 'image/jpeg' });
    expect(checkProofFile('PHOTO', WEBP)).toEqual({ mime: 'image/webp' });
    expect(checkProofFile('PHOTO', Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]))).toEqual({
      code: 'FILE_TOO_LARGE',
    });
    expect(checkProofFile('SIGNATURE', PNG)).toEqual({ mime: 'image/png' });
    expect(checkProofFile('SIGNATURE', JPEG)).toEqual({ code: 'UNSUPPORTED_TYPE' });
    expect(checkProofFile('SIGNATURE', Buffer.concat([PNG, Buffer.alloc(300 * 1024)]))).toEqual({
      code: 'FILE_TOO_LARGE',
    });
    expect(checkProofFile('PHOTO', Buffer.from('not an image'))).toEqual({ code: 'UNSUPPORTED_TYPE' });
    expect(checkProofFile('PHOTO', Buffer.alloc(0))).toEqual({ code: 'FILE_EMPTY' });
  });
});

describe('POST sync/delivery-proofs', () => {
  const STOP = '11111111-1111-4111-8111-111111111111';

  function world(opts: { photos?: number; stop?: boolean } = {}) {
    const rows: Array<{ id: string; client_ref: string }> = [];
    const saved: string[] = [];
    const em = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('SELECT id FROM delivery_proofs WHERE client_ref')) {
          return rows.filter((r) => r.client_ref === params[0]);
        }
        if (sql.includes('count(*)')) return [{ n: opts.photos ?? 0 }];
        if (sql.includes('INSERT INTO delivery_proofs')) {
          const r = { id: `proof-${rows.length + 1}`, client_ref: params[0] as string };
          rows.push(r);
          return [{ id: r.id }];
        }
        throw new Error(`unexpected SQL ${sql}`);
      },
    };
    const svc = new DeliveryProofsService(
      { transaction: async (fn: (m: typeof em) => unknown) => fn(em) } as never,
      {
        findOne: async ({ where }: { where: { clientRef: string } }) => {
          const r = rows.find((x) => x.client_ref === where.clientRef);
          return r ? { id: r.id, clientRef: r.client_ref } : null;
        },
      } as never,
      { findOne: async () => (opts.stop === false ? null : { id: STOP, runId: 'run-1' }) } as never,
      {} as never,
      { save: async (key: string) => void saved.push(key) } as never,
      { requireDeliveryRep: async () => ({ id: 'rep-1' }) } as never,
    );
    return { svc, rows, saved };
  }
  const file = (buffer: Buffer) => ({ buffer }) as Express.Multer.File;
  const actor = { sub: 'user-1', repId: 'rep-1' } as never;
  const dto = (over: Record<string, unknown> = {}) =>
    ({ clientRef: 'p-1', stopId: STOP, kind: 'PHOTO', capturedAt: '2026-11-08T10:40:00+03:00', ...over }) as never;

  it('stores the file under deliveries/<stopId>/<clientRef>.<ext> and answers created', async () => {
    const w = world();
    expect(await w.svc.upload(file(JPEG), dto(), actor)).toEqual({ created: true, proofId: 'proof-1', clientRef: 'p-1' });
    expect(w.saved).toEqual([`deliveries/${STOP}/p-1.jpg`]);
  });

  it('is idempotent on clientRef: the same ref again answers the same proof, not created', async () => {
    const w = world();
    await w.svc.upload(file(JPEG), dto(), actor);
    expect(await w.svc.upload(file(PNG), dto(), actor)).toEqual({ created: false, proofId: 'proof-1', clientRef: 'p-1' });
    expect(w.rows).toHaveLength(1);
    expect(w.saved).toHaveLength(1);
  });

  it('404 STOP_NOT_FOUND for an unknown stop', async () => {
    const w = world({ stop: false });
    await expect(w.svc.upload(file(JPEG), dto(), actor)).rejects.toMatchObject({
      response: { code: 'STOP_NOT_FOUND' },
    });
    await expect(w.svc.upload(file(JPEG), dto(), actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('422 TOO_MANY_PHOTOS past five photos; a signature is not counted', async () => {
    const w = world({ photos: MAX_PHOTOS_PER_STOP });
    await expect(w.svc.upload(file(JPEG), dto(), actor)).rejects.toMatchObject({
      response: { code: 'TOO_MANY_PHOTOS' },
    });
    expect(await w.svc.upload(file(PNG), dto({ clientRef: 's-1', kind: 'SIGNATURE' }), actor)).toMatchObject({
      created: true,
    });
  });

  it('422 for a file of the wrong kind, and nothing is stored', async () => {
    const w = world();
    await expect(w.svc.upload(file(JPEG), dto({ kind: 'SIGNATURE' }), actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(w.svc.upload(undefined, dto(), actor)).rejects.toMatchObject({ response: { code: 'FILE_EMPTY' } });
    expect(w.saved).toEqual([]);
  });
});
