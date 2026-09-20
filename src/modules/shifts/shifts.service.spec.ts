import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { ShiftsService } from './shifts.service';

/**
 * A working day is money-adjacent: it bounds what a rep is answerable for at
 * settlement. So the cases that matter are the ones that would quietly produce
 * a second day, or a day of negative length.
 */
describe('ShiftsService', () => {
  let rows: Record<string, unknown>[];

  function makeSvc(): ShiftsService {
    rows = [];
    const shifts = {
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) =>
          Object.entries(where).every(([k, v]) =>
            // IsNull() arrives as an object, not null — treat it as "is null".
            v !== null && typeof v === 'object' ? r[k] == null : r[k] === v,
          ),
        ) ?? null,
      ),
      create: jest.fn((v: Record<string, unknown>) => ({ id: `s-${rows.length + 1}`, ...v })),
      save: jest.fn(async (v: Record<string, unknown>) => {
        const i = rows.findIndex((r) => r.id === v.id);
        if (i >= 0) rows[i] = v; else rows.push(v);
        return v;
      }),
      find: jest.fn(async () => rows),
    };
    const reps = { exist: jest.fn().mockResolvedValue(true) };
    return new (ShiftsService as unknown as new (...a: unknown[]) => ShiftsService)(shifts, reps);
  }

  it('records the handset time, not the moment the row arrived', async () => {
    // The whole point: a shift that syncs after an outage must not be dated to
    // when coverage came back.
    const svc = makeSvc();
    const opened = await svc.open({ repId: 'r1', openedAt: '2026-09-20T06:15:00.000Z' });
    expect(opened.openedAt.toISOString()).toBe('2026-09-20T06:15:00.000Z');
  });

  it('answers a replayed open with 409 and the original shift', async () => {
    const svc = makeSvc();
    const first = await svc.open({ repId: 'r1', clientRef: 'uuid-1' });
    await expect(svc.open({ repId: 'r1', clientRef: 'uuid-1' })).rejects.toMatchObject({
      response: { code: 'duplicate_client_ref', shiftId: first.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses a SECOND open day — that is not a retry, it is a day counted twice', async () => {
    const svc = makeSvc();
    await svc.open({ repId: 'r1', clientRef: 'uuid-1' });
    // Different ref: a genuinely different open, on a day that never closed.
    await expect(svc.open({ repId: 'r1', clientRef: 'uuid-2' })).rejects.toMatchObject({
      response: { code: 'shift_already_open' },
    });
    expect(rows).toHaveLength(1);
  });

  it('lets a different rep open while one is already open', async () => {
    const svc = makeSvc();
    await svc.open({ repId: 'r1' });
    await expect(svc.open({ repId: 'r2' })).resolves.toBeTruthy();
    expect(rows).toHaveLength(2);
  });

  it('closes the open day, keeping the close coordinates apart from the open ones', async () => {
    const svc = makeSvc();
    await svc.open({ repId: 'r1', openedAt: '2026-09-20T06:00:00.000Z', openLat: 31.9, openLng: 35.9 });
    const closed = await svc.close('r1', {
      closedAt: '2026-09-20T17:30:00.000Z', closeLat: 32.1, closeLng: 36.1,
    });
    expect(closed.closedAt?.toISOString()).toBe('2026-09-20T17:30:00.000Z');
    expect([closed.openLat, closed.openLng]).toEqual([31.9, 35.9]);
    expect([closed.closeLat, closed.closeLng]).toEqual([32.1, 36.1]);
  });

  it('refuses a close earlier than the open rather than storing a negative day', async () => {
    const svc = makeSvc();
    await svc.open({ repId: 'r1', openedAt: '2026-09-20T09:00:00.000Z' });
    await expect(
      svc.close('r1', { closedAt: '2026-09-20T08:00:00.000Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('closing with nothing open is a 404, not a silently created shift', async () => {
    const svc = makeSvc();
    await expect(svc.close('r1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(0);
  });

  it('reopens after a close — a second day is fine once the first ended', async () => {
    const svc = makeSvc();
    await svc.open({ repId: 'r1' });
    await svc.close('r1', {});
    await expect(svc.open({ repId: 'r1' })).resolves.toBeTruthy();
    expect(rows).toHaveLength(2);
  });

  it('refuses an unknown rep', async () => {
    const svc = makeSvc();
    (svc as unknown as { reps: { exist: jest.Mock } }).reps.exist.mockResolvedValue(false);
    await expect(svc.open({ repId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never throws a bare ConflictException without saying which case it is', async () => {
    const svc = makeSvc();
    await svc.open({ repId: 'r1', clientRef: 'uuid-1' });
    const err = await svc.open({ repId: 'r1', clientRef: 'uuid-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as { response: { code?: string } }).response.code).toBeTruthy();
  });
});
