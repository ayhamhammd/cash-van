import { BadRequestException } from '@nestjs/common';

import { CustomersService } from './customers.service';
import type { CreateCustomerDto } from './dto/create-customer.dto';

/**
 * The segment a rep picks when they create a shop.
 *
 * A customer sits in exactly one segment, and until now the only way into one
 * was the dashboard: a rep who knew perfectly well that the shop they were
 * standing in is a wholesaler had no way to say so, and somebody in the office
 * had to file it later from a list of names they had never visited.
 *
 * What these pin is the part that is easy to get quietly wrong — that the
 * membership is actually written, that it is written as MANUAL so the rule
 * engine does not erase a person's choice on its next run, and that a segment
 * the server does not know is refused rather than dropped on the floor.
 */
describe('CustomersService — filing a new customer in a segment', () => {
  interface Membership {
    segmentId: string;
    customerId: string;
    source: string;
  }

  function makeSvc(world: { segments?: Array<{ id: string; isActive: boolean }> }) {
    const written: Membership[] = [];
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;

    svc.customers = {
      exist: async () => false,
      create: (v: Record<string, unknown>) => v,
      save: async (v: Record<string, unknown>) => ({ ...v, id: 'new-customer' }),
      query: async () => [{ n: '7' }],
    };
    svc.segments = {
      findOne: async ({ where }: { where: { id: string } }) =>
        (world.segments ?? []).find((s) => s.id === where.id) ?? null,
    };
    svc.segmentMembers = {
      create: (v: Membership) => v,
      save: async (v: Membership) => {
        written.push(v);
        return v;
      },
    };
    svc.events = { emit: () => true };

    return {
      written,
      create: (dto: Partial<CreateCustomerDto>) =>
        (svc as unknown as CustomersService).create({
          customerName: 'Shop',
          ...dto,
        } as CreateCustomerDto),
    };
  }

  const ACTIVE = { id: 'seg-active', isActive: true };
  const ARCHIVED = { id: 'seg-archived', isActive: false };

  it('files the customer in the segment that was chosen', async () => {
    const { written, create } = makeSvc({ segments: [ACTIVE] });
    await create({ segmentId: 'seg-active' });
    expect(written).toEqual([
      { segmentId: 'seg-active', customerId: 'new-customer', source: 'MANUAL' },
    ]);
  });

  it('marks the membership MANUAL so the rule engine cannot erase it', async () => {
    // RULE rows are rewritten wholesale on every run of the engine. A rep's
    // choice written as RULE would survive until the next refresh and no longer.
    const { written, create } = makeSvc({ segments: [ACTIVE] });
    await create({ segmentId: 'seg-active' });
    expect(written[0].source).toBe('MANUAL');
  });

  it('creates the customer with no membership when no segment was picked', async () => {
    // The field is optional: most creates will not carry one, and that must not
    // become a failed create or an empty membership row.
    const { written, create } = makeSvc({ segments: [ACTIVE] });
    const saved = await create({});
    expect(saved).toMatchObject({ id: 'new-customer' });
    expect(written).toEqual([]);
  });

  it('refuses a segment the server does not know', async () => {
    // Loudly, not silently. The id came from a picker this server filled, so a
    // miss means the app is sending something stale — and a customer quietly
    // filed nowhere is one the rep believes is segmented.
    const { create } = makeSvc({ segments: [ACTIVE] });
    await expect(create({ segmentId: 'seg-gone' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a segment the office has archived', async () => {
    const { written, create } = makeSvc({ segments: [ACTIVE, ARCHIVED] });
    await expect(create({ segmentId: 'seg-archived' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(written).toEqual([]);
  });
});
