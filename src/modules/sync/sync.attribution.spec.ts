import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { SyncService } from './sync.service';
import { SyncVoucherDto, SyncCollectionDto } from './dto/sync.dto';
import { PERM_ON_BEHALF } from '../../common/constants/permissions';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Who a synced document belongs to.
 *
 * `POST /v1/sync/vouchers` carried no `@Roles`, and both global guards allow a
 * route that declares nothing — so any authenticated token reached it. The
 * acting salesman was then read out of the request BODY (`userCode` for a
 * voucher, `repId` for a collection) and never compared against the caller.
 *
 * One rep could therefore post a sale out of another rep's van, in that rep's
 * name, against that rep's stock, landing in that rep's settlement and
 * commission — and the policy checks (returns, price floor) ran against the
 * CALLER's permissions, not the owner's.
 *
 * These pin the rule that replaced it: the owner comes from the token, and
 * naming someone else is a privilege, not a payload field.
 */
describe('SyncService — document attribution comes from the token', () => {
  class ReachedIntake extends Error {}

  function user(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
    return {
      sub: 'user-1',
      userNumber: 'U-0001',
      userType: 'SALES',
      role: 'viewer',
      repId: 'rep-1',
      permissions: {},
      permKeys: [],
      ...over,
    };
  }

  /** Stops at the claim, so these tests see the decision, not the insert. */
  function makeSvc(repLookup: Record<string, string> = {}) {
    const staged: Array<Record<string, unknown>> = [];
    const svc = Object.create(SyncService.prototype) as Record<string, unknown>;
    svc.staged = staged;
    svc.logger = { warn: () => undefined, log: () => undefined };

    // The intake claims its clientRef with a single INSERT ... ON CONFLICT DO
    // NOTHING. Capturing `values()` is how these tests read the attribution the
    // server decided on, which is the thing under test.
    const builder = {
      insert: () => builder,
      values: (v: Record<string, unknown>) => {
        staged.push(v);
        return builder;
      },
      orIgnore: () => builder,
      returning: () => builder,
      execute: () => {
        throw new ReachedIntake();
      },
    };

    svc.inbox = {
      createQueryBuilder: () => builder,
      findOne: async () => null,
      findOneByOrFail: async () => ({ id: 'row-1' }),
      manager: {
        query: async (sql: string, params: string[]) => {
          if (sql.includes('SELECT r.id')) {
            const id = repLookup[params[0]];
            return id ? [{ id }] : [];
          }
          // userCodeForRep
          const code = Object.entries(repLookup).find(([, id]) => id === params[0])?.[0];
          return code ? [{ user_number: code }] : [];
        },
      },
    };
    svc.vouchers = {
      reserveVoucherNumber: async () => 'INV-110101000001',
      resolveRepVanStore: async () => '110101',
    };
    return svc as unknown as SyncService;
  }

  const voucher = (over: Partial<SyncVoucherDto> = {}) =>
    ({
      transKind: 'SALE',
      userCode: 'U-0001',
      voucherNumber: 'INV-110101000009',
      transactions: [],
      ...over,
    }) as SyncVoucherDto;

  // ── The hole ──────────────────────────────────────────────────────────────

  it('refuses a voucher naming a different salesman', async () => {
    const svc = makeSvc({ 'U-0002': 'rep-2' });
    const err = await svc
      .ingestVoucher(voucher({ userCode: 'U-0002' }), user())
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as { response: Record<string, unknown> }).response).toMatchObject({
      code: 'REP_MISMATCH',
      tokenUserCode: 'U-0001',
      requested: 'U-0002',
    });
  });

  it('refuses a collection naming a different rep', async () => {
    const svc = makeSvc({ 'U-0002': 'rep-2' });
    const err = await svc
      .ingestCollection(
        { repId: 'rep-2', customerId: 'c-1', amount: 1000 } as unknown as SyncCollectionDto,
        user(),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as { response: Record<string, unknown> }).response).toMatchObject({
      code: 'REP_MISMATCH',
    });
  });

  it('refuses a caller with no rep link filing a document of its own', async () => {
    const svc = makeSvc();
    const err = await svc
      .ingestVoucher(voucher({ userCode: undefined }), user({ repId: null }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as { response: Record<string, unknown> }).response).toMatchObject({
      code: 'no_rep_link',
    });
  });

  // ── The normal path still works ───────────────────────────────────────────

  it('lets a rep file their own document', async () => {
    const svc = makeSvc({ 'U-0001': 'rep-1' });
    await expect(svc.ingestVoucher(voucher(), user())).rejects.toBeInstanceOf(
      ReachedIntake,
    );
  });

  it('fills the owner from the token when the body omits it', async () => {
    const svc = makeSvc({ 'U-0001': 'rep-1' });
    await expect(
      svc.ingestVoucher(voucher({ userCode: undefined }), user()),
    ).rejects.toBeInstanceOf(ReachedIntake);

    // A new APK can stop sending userCode entirely; the server knows who it is.
    // Asserted on the row about to be STAGED, not on the caller's dto — the dto
    // is destructured into a copy, so the owner is stamped on what persists.
    const [row] = (svc as unknown as { staged: Array<Record<string, unknown>> }).staged;
    expect(row).toMatchObject({ userCode: 'U-0001', repId: 'rep-1' });
    expect((row.payload as { userCode: string }).userCode).toBe('U-0001');
    // A clientRef is mandatory now that it is the conflict target; a request
    // without one is given a synthetic key rather than refused, so an older APK
    // keeps selling.
    expect(row.clientRef).toMatch(/^auto:/);
  });

  it('stamps the TARGET rep on an on-behalf document, not the caller', async () => {
    const svc = makeSvc({ 'U-0002': 'rep-2' });
    await expect(
      svc.ingestVoucher(
        voucher({ userCode: 'U-0002' }),
        user({ role: 'manager', repId: 'rep-1' }),
      ),
    ).rejects.toBeInstanceOf(ReachedIntake);

    // The document must land in rep-2's van and settlement — a manager acting
    // for a rep does not make it the manager's sale.
    const [row] = (svc as unknown as { staged: Array<Record<string, unknown>> }).staged;
    expect(row).toMatchObject({ userCode: 'U-0002', repId: 'rep-2' });
  });

  // ── Acting on behalf, deliberately ────────────────────────────────────────

  it('lets a manager file for another salesman', async () => {
    const svc = makeSvc({ 'U-0002': 'rep-2' });
    await expect(
      svc.ingestVoucher(
        voucher({ userCode: 'U-0002' }),
        user({ role: 'manager', repId: null }),
      ),
    ).rejects.toBeInstanceOf(ReachedIntake);
  });

  it('lets a holder of vouchers.createOnBehalf file for another salesman', async () => {
    const svc = makeSvc({ 'U-0002': 'rep-2' });
    await expect(
      svc.ingestVoucher(
        voucher({ userCode: 'U-0002' }),
        user({ permKeys: [PERM_ON_BEHALF] }),
      ),
    ).rejects.toBeInstanceOf(ReachedIntake);
  });

  it('rejects an on-behalf document naming a salesman that does not exist', async () => {
    const svc = makeSvc({});
    const err = await svc
      .ingestVoucher(voucher({ userCode: 'U-9999' }), user({ role: 'admin' }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
  });
});
