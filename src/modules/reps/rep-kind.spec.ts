import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateRepDto } from './dto/create-rep.dto';
import { UpdateRepDto } from './dto/update-rep.dto';
import { ListRepsQuery } from './dto/list-reps.query';
import { canDeliver } from './entities/rep.entity';

/** reps.kind on the wire (docs/SPEC-delivery-rep.md §4.1). */
describe('rep kind', () => {
  const errs = async <T extends object>(cls: new () => T, body: object) =>
    (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
      (e) => e.property,
    );

  it('create and update accept SALES | DELIVERY | BOTH and nothing else', async () => {
    for (const kind of ['SALES', 'DELIVERY', 'BOTH']) {
      expect(await errs(CreateRepDto, { code: 'D01', nameAr: 'س', kind })).toEqual([]);
      expect(await errs(UpdateRepDto, { kind })).toEqual([]);
    }
    expect(await errs(CreateRepDto, { code: 'D01', nameAr: 'س', kind: 'DRIVER' })).toContain('kind');
    expect(await errs(UpdateRepDto, { kind: 'delivery' })).toContain('kind');
  });

  it('the list filters by kind', async () => {
    expect(await errs(ListRepsQuery, { kind: 'DELIVERY' })).toEqual([]);
    expect(await errs(ListRepsQuery, { kind: 'X' })).toContain('kind');
  });

  it('DELIVERY and BOTH can deliver; SALES cannot', () => {
    expect(canDeliver('DELIVERY')).toBe(true);
    expect(canDeliver('BOTH')).toBe(true);
    expect(canDeliver('SALES')).toBe(false);
    expect(canDeliver(null)).toBe(false);
  });
});
