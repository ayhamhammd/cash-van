import { NotFoundException, ConflictException } from '@nestjs/common';

import { LoginApprovalsService, hashDevice } from './login-approvals.service';
import { deviceLabel } from './device-label';
import type { User } from '../users/entities/user.entity';

/**
 * Sign-ins from untrusted browsers wait for an administrator — when the switch
 * is on, for everyone but administrators, and only the browser that asked can
 * finish an approved sign-in, once.
 */

/** A tiny in-memory stand-in for a TypeORM repository: enough for this service. */
function memRepo<T extends Record<string, unknown>>() {
  const rows: T[] = [];
  let seq = 0;
  const matches = (r: T, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && '_type' in (v as object)) {
        const op = v as { _type: string; _value?: unknown };
        if (op._type === 'isNull') return r[k] == null;
        if (op._type === 'lessThan') return (r[k] as Date) < (op._value as Date);
        if (op._type === 'in') return (op._value as unknown[]).includes(r[k]);
      }
      return r[k] === v;
    });
  return {
    rows,
    create: (x: Partial<T>) => ({ ...x }) as T,
    save: async (x: T) => {
      if (!x.id) Object.assign(x, { id: `id-${++seq}`, createdAt: new Date(Date.now() + seq) });
      if (!rows.includes(x)) rows.push(x);
      return x;
    },
    findOne: async ({ where }: { where: Record<string, unknown> }) =>
      [...rows].reverse().find((r) => matches(r, where)) ?? null,
    find: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      rows.filter((r) => !where || matches(r, where)),
    update: async (where: Record<string, unknown>, patch: Partial<T>) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    },
  };
}

function setup(enabled = true) {
  const trusted = memRepo();
  const requests = memRepo();
  const users = memRepo();
  users.rows.push({ id: 'admin-1', role: 'admin', isActive: true, name: 'Admin' } as never);
  const notified: string[] = [];
  const svc = new LoginApprovalsService(
    trusted as never,
    requests as never,
    users as never,
    { requireDeviceApproval: async () => enabled } as never,
    { notifyUser: async (id: string) => { notified.push(id); } } as never,
    { emit: () => true } as never,
  );
  return { svc, trusted, requests, notified };
}

const clerk = { id: 'u-1', role: 'accountant', userType: 'OFFICE', name: 'Sara', userNumber: 'U-7' } as unknown as User;
const admin = { id: 'a-1', role: 'admin', userType: 'ADMIN', name: 'Boss', userNumber: 'U-1' } as unknown as User;
const laptop = { raw: 'x'.repeat(43), userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537', ip: '10.0.0.5' };

describe('LoginApprovalsService.gate', () => {
  it('lets everyone in while the switch is off', async () => {
    const { svc } = setup(false);
    await expect(svc.gate(clerk, laptop)).resolves.toEqual({ allowed: true });
  });

  it('never holds an administrator — they are the ones approving', async () => {
    const { svc } = setup();
    await expect(svc.gate(admin, laptop)).resolves.toEqual({ allowed: true });
  });

  it('holds an untrusted browser and tells the administrators', async () => {
    const { svc, requests, notified } = setup();
    const r = await svc.gate(clerk, laptop);
    expect(r.allowed).toBe(false);
    expect(requests.rows).toHaveLength(1);
    expect(requests.rows[0]).toMatchObject({ userId: 'u-1', deviceHash: hashDevice(laptop.raw), label: 'Chrome on Windows' });
    expect(notified).toEqual(['admin-1']);
  });

  it('pressing sign in twice is one request, not two', async () => {
    const { svc, requests } = setup();
    const a = await svc.gate(clerk, laptop);
    const b = await svc.gate(clerk, laptop);
    expect(requests.rows).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it('stores only a hash of the device cookie', async () => {
    const { svc, requests } = setup();
    await svc.gate(clerk, laptop);
    expect(JSON.stringify(requests.rows)).not.toContain(laptop.raw);
  });
});

describe('approving and finishing a sign-in', () => {
  it('approve once: this sign-in only, and only from the browser that asked', async () => {
    const { svc } = setup();
    const r = await svc.gate(clerk, laptop);
    if (r.allowed) throw new Error('expected a request');
    await expect(svc.complete(r.requestId, laptop.raw)).resolves.toEqual({ status: 'pending' });
    await svc.approve(r.requestId, 'admin-1', false);
    await expect(svc.complete(r.requestId, 'y'.repeat(43))).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.complete(r.requestId, laptop.raw)).resolves.toEqual({ status: 'approved', userId: 'u-1' });
    await expect(svc.complete(r.requestId, laptop.raw)).resolves.toEqual({ status: 'used' });
    // Not trusted: the next sign-in asks again.
    await expect(svc.gate(clerk, laptop)).resolves.toMatchObject({ allowed: false });
  });

  it('approve and trust: later sign-ins from that browser go straight in', async () => {
    const { svc } = setup();
    const r = await svc.gate(clerk, laptop);
    if (r.allowed) throw new Error('expected a request');
    await svc.approve(r.requestId, 'admin-1', true);
    await expect(svc.gate(clerk, laptop)).resolves.toEqual({ allowed: true });
  });

  it('a revoked device asks again', async () => {
    const { svc, trusted } = setup();
    const r = await svc.gate(clerk, laptop);
    if (r.allowed) throw new Error('expected a request');
    await svc.approve(r.requestId, 'admin-1', true);
    await svc.revoke(trusted.rows[0].id as string);
    await expect(svc.gate(clerk, laptop)).resolves.toMatchObject({ allowed: false });
  });

  it('a rejected sign-in stays rejected and cannot be approved afterwards', async () => {
    const { svc } = setup();
    const r = await svc.gate(clerk, laptop);
    if (r.allowed) throw new Error('expected a request');
    await svc.reject(r.requestId, 'admin-1');
    await expect(svc.complete(r.requestId, laptop.raw)).resolves.toEqual({ status: 'rejected' });
    await expect(svc.approve(r.requestId, 'admin-1', true)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a request nobody decided in time expires', async () => {
    const { svc, requests } = setup();
    const r = await svc.gate(clerk, laptop);
    if (r.allowed) throw new Error('expected a request');
    requests.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.complete(r.requestId, laptop.raw)).resolves.toEqual({ status: 'expired' });
  });
});

describe('deviceLabel', () => {
  it('names the browser and the system, nothing more', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605 Version/17.5 Safari/605')).toBe('Safari on macOS');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toBe('Edge on Windows');
    expect(deviceLabel(null)).toBe('Unknown browser');
  });
});
