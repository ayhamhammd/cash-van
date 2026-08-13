import { EventBridgeService } from './event-bridge.service';
import { SYNC_REQUIRED_EVENT } from './sync-signal';

/**
 * Routing tests for the salesman data signals.
 *
 * The failure this guards against is quiet: a signal sent to the wrong room, or
 * to no room, leaves a van selling yesterday's prices with nothing on screen to
 * suggest anything is wrong. Nobody reports it as a bug — they report wrong
 * totals, weeks later.
 */
describe('EventBridgeService — sync signals', () => {
  function build() {
    const toRep: Array<{ repId: string; event: string; payload: unknown }> = [];
    const toAll: Array<{ event: string; payload: unknown }> = [];
    const gateway = {
      broadcast: jest.fn(),
      emitToRep: (repId: string, event: string, payload: unknown) =>
        toRep.push({ repId, event, payload }),
      emitToAllReps: (event: string, payload: unknown) =>
        toAll.push({ event, payload }),
    };
    return { bridge: new EventBridgeService(gateway as never), toRep, toAll };
  }

  describe('offers', () => {
    // Eligibility is decided per customer at sell time, so there is no way to
    // know in advance which vans an offer will matter to.
    it('goes to every rep, never to a subset', () => {
      const { bridge, toRep, toAll } = build();
      bridge.onOffersChanged({ reason: 'offer.updated' });

      expect(toRep).toHaveLength(0);
      expect(toAll).toHaveLength(1);
      expect(toAll[0].event).toBe(SYNC_REQUIRED_EVENT);
      expect(toAll[0].payload).toMatchObject({
        resource: 'offers',
        reason: 'offer.updated',
      });
    });
  });

  describe('customers', () => {
    it('goes to the owning rep only', () => {
      const { bridge, toRep, toAll } = build();
      bridge.onCustomerChanged({ repId: 'r1', reason: 'customer.updated' });

      expect(toAll).toHaveLength(0);
      expect(toRep.map((c) => c.repId)).toEqual(['r1']);
      expect(toRep[0].payload).toMatchObject({ resource: 'customers' });
    });

    // The losing rep matters as much as the gaining one: left unsignalled, the
    // old van keeps a customer it no longer owns and carries on selling to it.
    it('signals BOTH sides of a reassignment', () => {
      const { bridge, toRep } = build();
      bridge.onCustomerChanged({
        repId: 'rNew',
        previousRepId: 'rOld',
        reason: 'customer.reassigned',
      });

      expect(new Set(toRep.map((c) => c.repId))).toEqual(new Set(['rNew', 'rOld']));
    });

    it('does not signal the same rep twice when nothing moved', () => {
      const { bridge, toRep } = build();
      bridge.onCustomerChanged({ repId: 'r1', previousRepId: 'r1' });

      expect(toRep).toHaveLength(1);
    });

    // A bulk ERP pull names no rep. Filtering the empty list used to send it to
    // nobody — the exact silent failure this suite exists for.
    it('falls back to every rep when no rep is named', () => {
      const { bridge, toRep, toAll } = build();
      bridge.onCustomerChanged({ reason: 'erp.customers.pulled' });

      expect(toRep).toHaveLength(0);
      expect(toAll).toHaveLength(1);
      expect(toAll[0].payload).toMatchObject({ resource: 'customers' });
    });
  });

  describe('stock', () => {
    it('goes to the van whose stock moved', () => {
      const { bridge, toRep, toAll } = build();
      bridge.onStockChanged({ repId: 'r7', reason: 'van.stock.adjusted' });

      expect(toAll).toHaveLength(0);
      expect(toRep[0]).toMatchObject({ repId: 'r7' });
    });

    it('falls back to every rep for an ERP-wide stock change', () => {
      const { bridge, toRep, toAll } = build();
      bridge.onStockChanged({ reason: 'erp.stock.pulled' });

      expect(toRep).toHaveLength(0);
      expect(toAll).toHaveLength(1);
    });
  });

  // Receiving the same signal twice must be indistinguishable from once, since
  // the app's only reaction is "pull that resource".
  it('carries no payload beyond resource, reason and timestamp', () => {
    const { bridge, toAll } = build();
    bridge.onOffersChanged({});

    expect(Object.keys(toAll[0].payload as object).sort()).toEqual([
      'at',
      'reason',
      'resource',
    ]);
  });
});
