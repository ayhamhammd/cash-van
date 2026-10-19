import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { ACCESS_TOKEN_COOKIE } from '../common/auth/auth-cookie';
import { RepScopeService } from '../modules/users/rep-scope.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { DEFAULT_TENANT_ID } from '../common/constants/tenancy';
import { UserContextService } from '../common/context/user-context.service';
import { TenantScope } from '../common/tenancy/tenant-scope.service';

/** Room every salesman socket joins, so a signal can reach all vans at once. */
export const REPS_ROOM = 'reps';
/** Per-salesman room: only this rep's device(s) receive the message. */
export const repRoom = (repId: string) => `rep:${repId}`;

/**
 * Dashboard WATCHER rooms — who may see events ABOUT a salesman, as opposed to
 * `repRoom`, which is the salesman's own device. See docs/SPEC-rep-scoped-users.md.
 */
export const SCOPE_ALL_ROOM = 'scope:all';
export const watchRoom = (repId: string) => `watch:${repId}`;

/** Every socket of one company, used by the operational broadcast. */
export const TENANT_ALL_ROOM = 'all';

/**
 * Namespaces a room to one company.
 *
 * Every room name goes through this, which is what keeps the tenants apart:
 * rep ids and user ids are uuids and would not collide by accident, but
 * `reps` and `scope:all` are shared names, and an un-namespaced broadcast on
 * either would deliver one company's live rep positions to another's
 * dashboard.
 */
export const tenantRoom = (tenantId: string, room: string) =>
  `t:${tenantId}:${room}`;

/**
 * Operational realtime stream.
 *
 * Two kinds of client share the namespace:
 *
 *   - **Dashboard** — receives the operational broadcast (rep locations, invoice
 *     events…). Unchanged: single-tenant, so those go to every socket.
 *   - **Salesman app** — additionally joins `rep:<id>` and `reps`, so the server
 *     can tell ONE van "your data changed" without waking the other nine.
 *
 * Rooms are assigned from the JWT's own `repId` claim at handshake, never from
 * anything the client sends. A device cannot ask to join another rep's room —
 * that would be a data leak dressed as a subscription.
 *
 * JWT auth is enforced at handshake; a missing or invalid token disconnects.
 *
 * Client:
 *   const socket = io('http://host/ws/ops', { auth: { token: jwt } });
 *   socket.on('sync.required', (p) => refresh(p.resource));
 */
@WebSocketGateway({ namespace: '/ws/ops', cors: { origin: true, credentials: true } })
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly repScope: RepScopeService,
    private readonly userCtx: UserContextService,
    private readonly tenants: TenantScope,
  ) {}

  handleConnection(client: Socket): void {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(`WS connection refused (no token): ${client.id}`);
      client.disconnect(true);
      return;
    }
    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.getOrThrow<string>('jwt.secret'),
      }) as {
        sub: string;
        role?: string;
        repId?: string | null;
        tid?: string;
      };
      client.data.userId = payload.sub;
      client.data.role = payload.role ?? 'viewer';

      // The company comes from the signed token, like every other room input.
      const tenantId = payload.tid ?? DEFAULT_TENANT_ID;
      client.data.tenantId = tenantId;
      const room = (name: string) => tenantRoom(tenantId, name);

      // Receives the operational broadcast for this company and no other.
      void client.join(room(TENANT_ALL_ROOM));

      // Room membership comes from the token, not from the client. A socket that
      // could name its own room could subscribe to a rival van's stock.
      const repId = payload.repId ?? null;
      client.data.repId = repId;
      if (repId) {
        void client.join(room(repRoom(repId)));
        void client.join(room(REPS_ROOM));
        // A salesman watches only themselves.
        void client.join(room(watchRoom(repId)));
        return;
      }

      // Dashboard socket: the scope lives in the database, not the token, so it
      // needs a lookup. Deliberately not awaited inside handleConnection —
      // Socket.IO does not gate delivery on it — which leaves a few-millisecond
      // window at connect where a scoped user is in no watcher room and simply
      // misses events. Missing one live ping is the safe failure; receiving
      // another supervisor's would not be.
      void this.joinWatchRooms(client, payload.sub);
    } catch {
      this.logger.warn(`WS connection refused (bad token): ${client.id}`);
      client.disconnect(true);
    }
  }

  /**
   * Join a dashboard socket to the watcher rooms its user is entitled to.
   *
   * Resolved once at handshake, so changing someone's assigned salesmen takes
   * effect on their next connection (a refresh), not mid-session. Worth knowing
   * when you widen a supervisor's scope and they say they still cannot see it.
   */
  private async joinWatchRooms(client: Socket, userId: string): Promise<void> {
    const tenantId = client.data.tenantId as string;
    const room = (name: string) => tenantRoom(tenantId, name);
    try {
      // The lookup itself has to run as this socket's tenant — rep_scope rows
      // are behind row-level security like everything else.
      const visible = await this.tenants.runWith(tenantId, () =>
        this.repScope.visibleRepIds({
          sub: userId,
          repId: null,
        } as AuthenticatedUser),
      );
      if (visible === null) {
        await client.join(room(SCOPE_ALL_ROOM));
        return;
      }
      await Promise.all(visible.map((id) => client.join(room(watchRoom(id)))));
    } catch (e) {
      // Fail CLOSED: a socket that joins nothing sees nothing, which is the
      // right outcome when we cannot establish what it is allowed to see.
      this.logger.warn(`WS scope lookup failed for ${client.id}: ${String(e)}`);
    }
  }

  /**
   * The company an emit belongs to.
   *
   * Domain events are emitted synchronously from inside the request that caused
   * them, so the request's tenant is still on the async context. Background work
   * has no request, and must pass `tenantId` explicitly — returning null there
   * makes the emit a no-op, which is the safe direction: better a dashboard that
   * refreshes a second late than one company's event on another's screen.
   */
  private tenantOf(explicit?: string | null): string | null {
    return explicit ?? this.userCtx.getTenantId();
  }

  /** Broadcast an event to every client of one company. */
  broadcast(event: string, payload: unknown, tenantId?: string | null): void {
    const tenant = this.tenantOf(tenantId);
    if (!this.server || !tenant) return;
    this.server.to(tenantRoom(tenant, TENANT_ALL_ROOM)).emit(event, payload);
  }

  /**
   * Broadcast an event that is ABOUT one salesman, to the dashboards allowed to
   * see them: unrestricted users plus that rep's assigned supervisors.
   *
   * A null/unknown repId goes to `scope:all` only — if we cannot say whose event
   * it is, no scoped supervisor should be told about it.
   */
  broadcastForRep(
    event: string,
    payload: unknown,
    repId?: string | null,
    tenantId?: string | null,
  ): void {
    const tenant = this.tenantOf(tenantId);
    if (!this.server || !tenant) return;
    const room = (name: string) => tenantRoom(tenant, name);
    const target = repId
      ? this.server.to([room(SCOPE_ALL_ROOM), room(watchRoom(repId))])
      : this.server.to(room(SCOPE_ALL_ROOM));
    target.emit(event, payload);
  }

  /**
   * Send to one salesman's device(s) only.
   *
   * A no-op when that rep has nothing connected — which is the normal case for a
   * van that is offline or asleep. Nothing is queued: the app reconciles by
   * pulling on next foreground, so a missed signal costs freshness, not data.
   */
  emitToRep(
    repId: string,
    event: string,
    payload: unknown,
    tenantId?: string | null,
  ): void {
    const tenant = this.tenantOf(tenantId);
    if (!this.server || !repId || !tenant) return;
    this.server.to(tenantRoom(tenant, repRoom(repId))).emit(event, payload);
  }

  /** Send to every connected salesman of one company, not to dashboards. */
  emitToAllReps(event: string, payload: unknown, tenantId?: string | null): void {
    const tenant = this.tenantOf(tenantId);
    if (!this.server || !tenant) return;
    this.server.to(tenantRoom(tenant, REPS_ROOM)).emit(event, payload);
  }

  private extractToken(client: Socket): string | null {
    // Browser clients authenticate via the httpOnly cookie sent on the handshake.
    const fromCookie = this.tokenFromCookie(client.handshake.headers?.cookie);
    if (fromCookie) return fromCookie;
    const fromAuth = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (fromAuth) return fromAuth;
    const fromQuery = client.handshake.query?.token;
    if (typeof fromQuery === 'string') return fromQuery;
    const header = client.handshake.headers?.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return null;
  }

  private tokenFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === ACCESS_TOKEN_COOKIE) return decodeURIComponent(rest.join('='));
    }
    return null;
  }
}
