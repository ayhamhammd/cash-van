import { ForbiddenException } from '@nestjs/common';

import { ApprovalsService } from './approvals.service';
import type { ApprovalRequest, ApprovalType } from './entities/approval-request.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * A supervisor deciding their own salesmen's new customers.
 *
 * WHY THEY WERE LET IN. A shop created in the field waits until someone
 * approves it, and until now that someone had to be an admin or a manager —
 * so a rep standing in a new shop could not sell to it until head office
 * looked. The person who actually knows whether that shop is real is the
 * supervisor whose reps call on the street.
 *
 * TWO GATES, and they answer different questions. `assertCanSeeRep` answers
 * WHOSE — a supervisor may not touch another supervisor's salesmen, which the
 * service already enforced. These cover the second: WHAT. The approvals queue
 * also carries discounts, price overrides and returns, and those are money
 * decisions that stay with admin and manager.
 */
describe('ApprovalsService — what a supervisor may decide', () => {
  const svc = Object.create(ApprovalsService.prototype) as {
    findOneForReviewer(id: string, u: AuthenticatedUser): Promise<ApprovalRequest>;
    assertReviewerMayDecide(u: AuthenticatedUser, row: ApprovalRequest): void;
  };

  const user = (role: string): AuthenticatedUser =>
    ({ sub: 'u1', role } as unknown as AuthenticatedUser);

  const request = (type: ApprovalType): ApprovalRequest =>
    ({ id: 'a1', type, status: 'pending', repId: 'rep-1' } as ApprovalRequest);

  /** The private gate, reached the way the service reaches it. */
  const decide = (role: string, type: ApprovalType) =>
    (svc as unknown as {
      assertReviewerMayDecide(u: AuthenticatedUser, r: ApprovalRequest): void;
    }).assertReviewerMayDecide(user(role), request(type));

  it('lets a supervisor decide a new-customer request', () => {
    expect(() => decide('supervisor', 'CUSTOMER_CREATE')).not.toThrow();
  });

  it.each<ApprovalType>(['VOUCHER_DISCOUNT', 'PRICE_OVERRIDE', 'RETURN_VOUCHER'])(
    'refuses a supervisor a %s — those are money decisions',
    (type) => {
      expect(() => decide('supervisor', type)).toThrow(ForbiddenException);
    },
  );

  it.each(['admin', 'manager'])('leaves %s able to decide anything', (role) => {
    expect(() => decide(role, 'VOUCHER_DISCOUNT')).not.toThrow();
    expect(() => decide(role, 'CUSTOMER_CREATE')).not.toThrow();
    expect(() => decide(role, 'PRICE_OVERRIDE')).not.toThrow();
  });

  /**
   * The detail route used to read any request by id with no scope check at
   * all, while the list it came from was filtered per supervisor. Harmless
   * while only head office could reach it; a hole the moment supervisors can.
   */
  describe('findOneForReviewer', () => {
    function make(row: ApprovalRequest, visibleRepIds: string[] | null) {
      const s = Object.create(ApprovalsService.prototype) as Record<string, unknown>;
      s.repo = { findOne: async () => row };
      s.repScope = {
        assertCanSeeRep: async (_u: AuthenticatedUser, repId: string) => {
          if (visibleRepIds !== null && !visibleRepIds.includes(repId)) {
            throw new ForbiddenException('This salesman is outside your assigned scope');
          }
        },
      };
      return s as unknown as ApprovalsService;
    }

    it('returns a request for one of the supervisor’s own salesmen', async () => {
      const row = request('CUSTOMER_CREATE');
      const s = make(row, ['rep-1']);
      await expect(s.findOneForReviewer('a1', user('supervisor'))).resolves.toBe(row);
    });

    it('refuses a request belonging to another supervisor’s salesman', async () => {
      const s = make(request('CUSTOMER_CREATE'), ['rep-9']);
      await expect(s.findOneForReviewer('a1', user('supervisor'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('refuses a discount even for their own salesman', async () => {
      const s = make(request('VOUCHER_DISCOUNT'), ['rep-1']);
      await expect(s.findOneForReviewer('a1', user('supervisor'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('gives an unrestricted manager the request whatever it is', async () => {
      const row = request('VOUCHER_DISCOUNT');
      const s = make(row, null);
      await expect(s.findOneForReviewer('a1', user('manager'))).resolves.toBe(row);
    });
  });
});
