import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UserResponseDto } from './dto/user-response.dto';
import { User } from './entities/user.entity';

/**
 * Everything a user's row REMEMBERS has to survive being read back.
 *
 * UserResponseDto is a hand-written allow-list, and that is the whole hazard: a
 * flag can be added to the entity, to the create path, to the login payload and
 * to the screen, and still be dropped here — in which case saving appears to
 * work and the setting is simply gone the next time anybody looks. That is
 * exactly what happened to `requireLocation`: an admin ticked "require location
 * to be on" for a salesman, saved, reopened the drawer, and found it unticked,
 * because the read never carried it even though the column held `true`.
 *
 * So this does not list the flags by hand — a list somebody must remember to
 * update is the same trap one level up. It reads the ENTITY and requires every
 * boolean column on it to come back out of `fromEntity`.
 */
describe('UserResponseDto carries every flag the user row stores', () => {
  /** Boolean columns declared on the entity, read from its source. */
  const entityBooleanColumns = (): string[] => {
    const src = readFileSync(
      join(__dirname, 'entities', 'user.entity.ts'),
      'utf8',
    );
    // `@Column({ ... type: 'boolean' ... })` followed by the property it decorates.
    const re = /@Column\(\{[^}]*type:\s*'boolean'[^}]*\}\)\s*\n\s*(\w+)!?:/g;
    const names: string[] = [];
    for (let m = re.exec(src); m; m = re.exec(src)) names.push(m[1]);
    return names;
  };

  /**
   * A user with every boolean ON, so a flag that is dropped reads as `undefined`
   * rather than coincidentally matching a `false` default.
   */
  const userWithEverythingOn = (): User => {
    const u = {
      id: 'u-1',
      userNumber: 'U-1',
      name: 'Test',
      nameAr: null,
      nameEn: null,
      email: null,
      permissions: [],
      repScopeMode: 'all',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Record<string, unknown>;
    for (const col of entityBooleanColumns()) u[col] = true;
    return u as unknown as User;
  };

  it('finds the entity’s boolean columns at all', () => {
    // If the regex ever stops matching, every assertion below passes vacuously
    // and this file becomes decoration.
    const cols = entityBooleanColumns();
    expect(cols.length).toBeGreaterThan(10);
    expect(cols).toContain('canCreateSale');
    expect(cols).toContain('requireLocation');
  });

  it('returns every boolean column the entity declares', () => {
    const dto = UserResponseDto.fromEntity(userWithEverythingOn()) as unknown as Record<
      string,
      unknown
    >;
    // `mustChangePassword` is the one deliberate omission: it is an auth-flow
    // detail of the account, not a capability an admin edits on this screen.
    const notForThisScreen = new Set(['mustChangePassword']);
    const missing = entityBooleanColumns()
      .filter((c) => !notForThisScreen.has(c))
      .filter((c) => dto[c] === undefined);
    expect(missing).toEqual([]);
  });

  it('carries requireLocation specifically', async () => {
    // The one that shipped broken. Kept as its own case so a failure names it
    // rather than appearing as an entry in a list.
    const dto = UserResponseDto.fromEntity(userWithEverythingOn());
    expect(dto.requireLocation).toBe(true);
  });

  it('reports a flag that is OFF as false, not as missing', async () => {
    const u = userWithEverythingOn() as unknown as Record<string, unknown>;
    u.requireLocation = false;
    const dto = UserResponseDto.fromEntity(u as unknown as User);
    // A screen reading `!!value` cannot tell undefined from false, which is why
    // the original bug looked like "it did not save" rather than "it did not load".
    expect(dto.requireLocation).toBe(false);
  });
});
