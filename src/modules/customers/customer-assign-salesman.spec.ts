import { ForbiddenException } from '@nestjs/common';
import { CustomersService, canAssignSalesman } from './customers.service';

/**
 * Moving a customer to another salesman is its own permission,
 * `customers.assignSalesman` — from the edit form as well as the reassign button
 * and the Excel assignment, so the form is not a way round the other two.
 */
function makeSvc(customer: Record<string, unknown>) {
  const svc = Object.create(CustomersService.prototype) as any;
  svc.findOneOrThrow = jest.fn().mockResolvedValue(customer);
  svc.customers = { save: jest.fn(async (c: unknown) => c) };
  svc.events = { emit: jest.fn() };
  svc.areas = { assertAssignable: jest.fn() };
  return svc as CustomersService;
}

describe('changing a customer’s salesman', () => {
  it('is refused without the permission', async () => {
    const svc = makeSvc({ id: 'c1', repId: 'rep-a' });
    await expect(
      svc.update('c1', { repId: 'rep-b' } as any, { canAssignSalesman: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is allowed with it', async () => {
    const svc = makeSvc({ id: 'c1', repId: 'rep-a' });
    await expect(
      svc.update('c1', { repId: 'rep-b' } as any, { canAssignSalesman: true }),
    ).resolves.toMatchObject({ repId: 'rep-b' });
  });

  it('lets an edit through that sends the salesman the customer already has', async () => {
    const svc = makeSvc({ id: 'c1', repId: 'rep-a', customerName: 'Old' });
    await expect(
      svc.update('c1', { repId: 'rep-a', customerName: 'New' } as any, { canAssignSalesman: false }),
    ).resolves.toMatchObject({ customerName: 'New' });
  });

  it('lets an edit through that does not touch the salesman', async () => {
    const svc = makeSvc({ id: 'c1', repId: 'rep-a' });
    await expect(
      svc.update('c1', { customerName: 'New' } as any, { canAssignSalesman: false }),
    ).resolves.toMatchObject({ customerName: 'New' });
  });
});

describe('canAssignSalesman', () => {
  it('admins always may; others need the key', () => {
    expect(canAssignSalesman({ role: 'admin', permKeys: [] })).toBe(true);
    expect(canAssignSalesman({ role: 'manager', permKeys: ['customers.assignSalesman'] })).toBe(true);
    expect(canAssignSalesman({ role: 'manager', permKeys: ['customers.edit'] })).toBe(false);
    expect(canAssignSalesman(null)).toBe(false);
  });
});
