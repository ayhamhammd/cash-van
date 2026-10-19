import { EventsGateway, REPS_ROOM, SCOPE_ALL_ROOM, TENANT_ALL_ROOM, repRoom, tenantRoom, watchRoom } from './events.gateway';

/**
 * Every emit must name a room that is namespaced to one company. These are the
 * cheap checks that catch the expensive bug: `reps` and `scope:all` are shared
 * names, so an un-namespaced emit would put one company's live rep positions on
 * another company's dashboard.
 */

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

/** Records what the gateway asked socket.io to send, and where. */
function fakeServer() {
  const sent: { rooms: string[]; event: string }[] = [];
  return {
    sent,
    to(rooms: string | string[]) {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      return {
        emit: (event: string) => sent.push({ rooms: list, event }),
      };
    },
    emit: (event: string) => sent.push({ rooms: ['__GLOBAL__'], event }),
  };
}

function gatewayWithTenant(tenantId: string | null) {
  const gateway = new EventsGateway(
    {} as never,
    {} as never,
    {} as never,
    { getTenantId: () => tenantId } as never,
    {} as never,
  );
  const server = fakeServer();
  (gateway as unknown as { server: unknown }).server = server;
  return { gateway, server };
}

describe('EventsGateway — every emit is namespaced to one company', () => {
  it('namespaces room names', () => {
    expect(tenantRoom(TENANT_A, REPS_ROOM)).toBe(`t:${TENANT_A}:reps`);
    expect(tenantRoom(TENANT_A, REPS_ROOM)).not.toBe(
      tenantRoom(TENANT_B, REPS_ROOM),
    );
  });

  it('broadcasts to the caller tenant only', () => {
    const { gateway, server } = gatewayWithTenant(TENANT_A);
    gateway.broadcast('rep.location', { x: 1 });

    expect(server.sent).toHaveLength(1);
    expect(server.sent[0].rooms).toEqual([
      tenantRoom(TENANT_A, TENANT_ALL_ROOM),
    ]);
  });

  it('never falls back to a global emit', () => {
    const { gateway, server } = gatewayWithTenant(TENANT_A);
    gateway.broadcast('rep.location', {});
    gateway.emitToAllReps('sync.required', {});
    gateway.emitToRep('rep-1', 'sync.required', {});
    gateway.broadcastForRep('invoice.created', {}, 'rep-1');

    expect(server.sent).toHaveLength(4);
    for (const s of server.sent) {
      expect(s.rooms).not.toContain('__GLOBAL__');
      for (const room of s.rooms) {
        expect(room.startsWith(`t:${TENANT_A}:`)).toBe(true);
      }
    }
  });

  it('scopes the per-rep and watcher rooms', () => {
    const { gateway, server } = gatewayWithTenant(TENANT_A);
    gateway.emitToRep('rep-1', 'sync.required', {});
    gateway.broadcastForRep('invoice.created', {}, 'rep-1');

    expect(server.sent[0].rooms).toEqual([
      tenantRoom(TENANT_A, repRoom('rep-1')),
    ]);
    expect(server.sent[1].rooms).toEqual([
      tenantRoom(TENANT_A, SCOPE_ALL_ROOM),
      tenantRoom(TENANT_A, watchRoom('rep-1')),
    ]);
  });

  // Background work carries no request context. Emitting to everyone would be
  // the worst possible default, so the emit is dropped instead.
  it('drops the emit when no tenant can be resolved', () => {
    const { gateway, server } = gatewayWithTenant(null);
    gateway.broadcast('rep.location', {});
    gateway.emitToAllReps('sync.required', {});

    expect(server.sent).toHaveLength(0);
  });

  it('uses an explicitly passed tenant over the ambient one', () => {
    const { gateway, server } = gatewayWithTenant(TENANT_A);
    gateway.broadcast('rep.location', {}, TENANT_B);

    expect(server.sent[0].rooms).toEqual([
      tenantRoom(TENANT_B, TENANT_ALL_ROOM),
    ]);
  });
});
