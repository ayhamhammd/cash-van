import { CustomersService } from './customers.service';
import type { CreateCustomerDto } from './dto/create-customer.dto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * A salesman's segment and area reach the customer only when the office allowed
 * them (canSetCustomerSegment / canSetCustomerArea, off by default).
 *
 * The app hides both pickers without the switch; these pin that the server
 * drops them too — on the direct path and the approval path — so a phone whose
 * session predates the office turning one off cannot slip them through. The GPS
 * location is not one of them and always passes. An office user is not a
 * salesman and is left alone.
 */
describe('CustomersService.createAsUser — segment and area need their switches', () => {
  function makeSvc(flags: { direct: boolean; segment: boolean; area: boolean }) {
    const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
    const created: Array<Partial<CreateCustomerDto>> = [];
    const requested: Array<Partial<CreateCustomerDto>> = [];

    svc.pendingPhotos = { findOne: async () => ({ id: 'photo-1', claimedAt: null }) };
    svc.users = {
      findOne: async () => ({
        id: 'user-1',
        canCreateCustomerDirect: flags.direct,
        canSetCustomerSegment: flags.segment,
        canSetCustomerArea: flags.area,
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
      areaId: 'area-1',
      latitude: '31.950000',
      longitude: '35.930000',
    }) as CreateCustomerDto;

  it('drops both when the salesman has neither switch — but keeps the GPS location', async () => {
    const { svc, created } = makeSvc({ direct: true, segment: false, area: false });
    await svc.createAsUser(dto(), salesman);
    expect(created[0].segmentId).toBeUndefined();
    expect(created[0].areaId).toBeUndefined();
    expect(created[0]).toMatchObject({
      customerName: 'Shop',
      latitude: '31.950000',
      longitude: '35.930000',
    });
  });

  it('keeps each one its switch allows, independently', async () => {
    const segOnly = makeSvc({ direct: true, segment: true, area: false });
    await segOnly.svc.createAsUser(dto(), salesman);
    expect(segOnly.created[0]).toMatchObject({ segmentId: 'seg-1' });
    expect(segOnly.created[0].areaId).toBeUndefined();

    const areaOnly = makeSvc({ direct: true, segment: false, area: true });
    await areaOnly.svc.createAsUser(dto(), salesman);
    expect(areaOnly.created[0]).toMatchObject({ areaId: 'area-1' });
    expect(areaOnly.created[0].segmentId).toBeUndefined();
  });

  it('an approval request carries only what was allowed', async () => {
    const { svc, requested } = makeSvc({ direct: false, segment: false, area: false });
    await svc.createAsUser(dto(), salesman);
    expect(requested[0].segmentId).toBeUndefined();
    expect(requested[0].areaId).toBeUndefined();
  });

  it('an office user keeps the segment and area they entered', async () => {
    const { svc, created } = makeSvc({ direct: true, segment: false, area: false });
    await svc.createAsUser(dto(), office);
    expect(created[0]).toMatchObject({ segmentId: 'seg-1', areaId: 'area-1' });
  });
});
