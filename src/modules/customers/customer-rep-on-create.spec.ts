import { CustomersService } from './customers.service';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * A customer a salesman creates is HIS — decided by the server from the login.
 *
 * The app fills `repId` from its session only when the session has one, so a
 * blank field used to produce a customer that belonged to nobody: missing from
 * the rep's own van list, and exported to the ERP with no salesman. These pin
 * that the login decides, on both the direct path and the approval path, and
 * that an office user is left alone to assign whomever they choose.
 */
describe('CustomersService.createAsUser — the rep comes from the login', () => {
  function makeSvc(opts: { direct: boolean }) {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    const created: Array<Partial<CreateCustomerDto>> = [];
    const requested: Array<Partial<CreateCustomerDto>> = [];

    svc.pendingPhotos = { findOne: async () => ({ id: 'photo-1', claimedAt: null }) };
    svc.users = { findOne: async () => ({ id: 'user-1', canCreateCustomerDirect: opts.direct }) };
    svc.create = jest.fn(async (dto: CreateCustomerDto) => {
      created.push(dto);
      return { id: 'cust-1', ...dto };
    });
    svc.claimPhoto = jest.fn();
    svc.claimExtraPhotos = jest.fn();
    svc.approvals = {
      createCustomerRequest: jest.fn(async (dto: CreateCustomerDto) => {
        requested.push(dto);
        return { id: 'req-1' };
      }),
    };
    return { svc: svc as unknown as CustomersService, created, requested };
  }

  const salesman = { sub: 'user-1', repId: 'rep-101' } as AuthenticatedUser;
  const office = { sub: 'user-9', repId: null } as AuthenticatedUser;
  const dto = (extra: Partial<CreateCustomerDto> = {}) =>
    ({ customerName: 'Shop', photoId: 'photo-1', ...extra }) as CreateCustomerDto;

  it('assigns the salesman even when the phone sent no repId', async () => {
    const { svc, created } = makeSvc({ direct: true });
    await svc.createAsUser(dto(), salesman);
    expect(created[0].repId).toBe('rep-101');
  });

  it('assigns the salesman even when the phone named somebody else', async () => {
    const { svc, created } = makeSvc({ direct: true });
    await svc.createAsUser(dto({ repId: 'rep-202' }), salesman);
    expect(created[0].repId).toBe('rep-101');
  });

  it('a request waiting on approval carries the rep, so the approved customer is his', async () => {
    const { svc, created, requested } = makeSvc({ direct: false });
    const out = await svc.createAsUser(dto(), salesman);
    expect(out).toEqual({ pendingApprovalId: 'req-1', status: 'pending' });
    expect(created).toHaveLength(0);
    expect(requested[0].repId).toBe('rep-101');
  });

  it('an office user assigns whomever they choose — or nobody', async () => {
    const { svc, created } = makeSvc({ direct: true });
    await svc.createAsUser(dto({ repId: 'rep-202' }), office);
    await svc.createAsUser(dto(), office);
    expect(created.map((c) => c.repId)).toEqual(['rep-202', undefined]);
  });
});

describe('CustomersService.create — the rep rides the ERP event', () => {
  it('names the rep on erp.customer.created, so the ERP can assign the salesman', async () => {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    const emitted: Array<[string, Record<string, unknown>]> = [];
    svc.customers = {
      exist: async () => false,
      create: (v: Record<string, unknown>) => v,
      save: async (v: Record<string, unknown>) => ({ ...v, id: 'new-customer' }),
      query: async () => [{ n: '7' }],
    };
    svc.fileInSegment = jest.fn();
    svc.events = { emit: (name: string, p: Record<string, unknown>) => emitted.push([name, p]) };

    await (svc as unknown as CustomersService).create({
      customerName: 'Shop',
      customerNumber: 'C-101-1',
      repId: 'rep-101',
    } as CreateCustomerDto);

    const erp = emitted.find(([n]) => n === 'erp.customer.created');
    expect(erp?.[1]).toMatchObject({ code: 'C-101-1', repId: 'rep-101' });
  });
});
