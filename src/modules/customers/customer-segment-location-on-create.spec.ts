import { CustomersService } from './customers.service';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * A salesman's segment and GPS location reach the customer only when the office
 * allowed them (canSetCustomerSegment / canSetCustomerLocation, off by default).
 *
 * The app hides both sections without the switch; these pin that the server
 * drops them too — on the direct path and the approval path — so a phone whose
 * session predates the office turning one off cannot slip them through. An
 * office user is not a salesman and is left alone.
 */
describe('CustomersService.createAsUser — segment and location need their switches', () => {
  function makeSvc(flags: { direct: boolean; segment: boolean; location: boolean }) {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    const created: Array<Partial<CreateCustomerDto>> = [];
    const requested: Array<Partial<CreateCustomerDto>> = [];

    svc.pendingPhotos = { findOne: async () => ({ id: 'photo-1', claimedAt: null }) };
    svc.users = {
      findOne: async () => ({
        id: 'user-1',
        canCreateCustomerDirect: flags.direct,
        canSetCustomerSegment: flags.segment,
        canSetCustomerLocation: flags.location,
      }),
    };
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
  const dto = () =>
    ({
      customerName: 'Shop',
      photoId: 'photo-1',
      segmentId: 'seg-1',
      latitude: '31.950000',
      longitude: '35.930000',
    }) as CreateCustomerDto;

  it('drops both when the salesman has neither switch', async () => {
    const { svc, created } = makeSvc({ direct: true, segment: false, location: false });
    await svc.createAsUser(dto(), salesman);
    expect(created[0].segmentId).toBeUndefined();
    expect(created[0].latitude).toBeUndefined();
    expect(created[0].longitude).toBeUndefined();
    expect(created[0].customerName).toBe('Shop');
  });

  it('keeps each one its switch allows, independently', async () => {
    const segOnly = makeSvc({ direct: true, segment: true, location: false });
    await segOnly.svc.createAsUser(dto(), salesman);
    expect(segOnly.created[0]).toMatchObject({ segmentId: 'seg-1' });
    expect(segOnly.created[0].latitude).toBeUndefined();

    const locOnly = makeSvc({ direct: true, segment: false, location: true });
    await locOnly.svc.createAsUser(dto(), salesman);
    expect(locOnly.created[0]).toMatchObject({ latitude: '31.950000', longitude: '35.930000' });
    expect(locOnly.created[0].segmentId).toBeUndefined();
  });

  it('an approval request carries only what was allowed', async () => {
    const { svc, requested } = makeSvc({ direct: false, segment: false, location: false });
    await svc.createAsUser(dto(), salesman);
    expect(requested[0].segmentId).toBeUndefined();
    expect(requested[0].latitude).toBeUndefined();
  });

  it('an office user keeps the segment and location they entered', async () => {
    const { svc, created } = makeSvc({ direct: true, segment: false, location: false });
    await svc.createAsUser(dto(), office);
    expect(created[0]).toMatchObject({
      segmentId: 'seg-1',
      latitude: '31.950000',
      longitude: '35.930000',
    });
  });
});
