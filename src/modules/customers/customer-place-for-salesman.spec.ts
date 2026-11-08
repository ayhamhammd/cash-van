/**
 * What a customer row says about its place, per reader and mode.
 *
 *  - The dashboard always gets the tree fields as stored.
 *  - A salesman in TREE mode gets them, and the flat fields carry the tree
 *    area too, for an app build that knows only areaId/areaName.
 *  - A salesman in FLAT mode gets none: the app shows a tree place whenever it
 *    has one, so a company that switched back must see its phones follow.
 */
import { CustomersService } from './customers.service';

type Row = Record<string, unknown>;

function build(mode: 'FLAT' | 'TREE') {
  const svc = Object.create(CustomersService.prototype) as Record<string, unknown>;
  svc.areas = { namesById: async () => new Map([['area-1', 'الشمال']]) };
  svc.settings = { locationMode: async () => mode };
  // Who also serves each shop — none here.
  svc.customers = { query: async () => [] };
  svc.locations = {
    labels: async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            locationId: id,
            locationName: 'الجبيهة',
            governorateId: 'gov-1',
            governorateName: 'عمّان',
            governorateCode: 'JO-AM',
            locationLabel: 'عمّان - الجبيهة',
          },
        ]),
      ),
  };
  const attach = (svc as unknown as { attachPlace: (i: Row[], o: { forSalesman?: boolean }) => Promise<void> })
    .attachPlace.bind(svc);
  return attach;
}

const row = (): Row => ({ id: 'c1', areaId: 'area-1', locationId: 'loc-1' });

describe('a customer row’s place', () => {
  it('gives the dashboard the tree as stored, in either mode', async () => {
    for (const mode of ['FLAT', 'TREE'] as const) {
      const c = row();
      await build(mode)([c], {});
      expect(c).toMatchObject({ areaId: 'area-1', areaName: 'الشمال', locationLabel: 'عمّان - الجبيهة' });
    }
  });

  it('gives a salesman in TREE mode the tree, mirrored into the flat fields', async () => {
    const c = row();
    await build('TREE')([c], { forSalesman: true });
    expect(c).toMatchObject({
      areaId: 'loc-1',
      areaName: 'عمّان - الجبيهة',
      governorateId: 'gov-1',
      locationLabel: 'عمّان - الجبيهة',
    });
  });

  it('gives a salesman in FLAT mode no tree at all', async () => {
    const c = row();
    await build('FLAT')([c], { forSalesman: true });
    expect(c).toMatchObject({
      areaId: 'area-1',
      areaName: 'الشمال',
      locationName: null,
      governorateId: null,
      governorateName: null,
      locationLabel: null,
    });
  });
});
