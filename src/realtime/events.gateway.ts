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
      }) as { sub: string; role?: string; repId?: string | null };
      client.data.userId = payload.sub;
      client.data.role = payload.role ?? 'viewer';

      // Room membership comes from the token, not from the client. A socket that
      // could name its own room could subscribe to a rival van's stock.
      const repId = payload.repId ?? null;
      client.data.repId = repId;
      if (repId) {
        void client.join(repRoom(repId));
        void client.join(REPS_ROOM);
        // A salesman watches only themselves.
        void client.join(watchRoom(repId));
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
    try {
      const visible = await this.repScope.visibleRepIds({
        sub: userId,
        repId: null,
      } as AuthenticatedUser);
      if (visible === null) {
        await client.join(SCOPE_ALL_ROOM);
        return;
      }
      await Promise.all(visible.map((id) => client.join(watchRoom(id))));
    } catch (e) {
      // Fail CLOSED: a socket that joins nothing sees nothing, which is the
      // right outcome when we cannot establish what it is allowed to see.
      this.logger.warn(`WS scope lookup failed for ${client.id}: ${String(e)}`);
    }
  }

  /** Broadcast an event to every connected client. */
  broadcast(event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.emit(event, payload);
  }

  /**
   * Broadcast an event that is ABOUT one salesman, to the dashboards allowed to
   * see them: unrestricted users plus that rep's assigned supervisors.
   *
   * A null/unknown repId goes to `scope:all` only — if we cannot say whose event
   * it is, no scoped supervisor should be told about it.
   */
  broadcastForRep(event: string, payload: unknown, repId?: string | null): void {
    if (!this.server) return;
    const target = repId
      ? this.server.to([SCOPE_ALL_ROOM, watchRoom(repId)])
      : this.server.to(SCOPE_ALL_ROOM);
    target.emit(event, payload);
  }

  /**
   * Send to one salesman's device(s) only.
   *
   * A no-op when that rep has nothing connected — which is the normal case for a
   * van that is offline or asleep. Nothing is queued: the app reconciles by
   * pulling on next foreground, so a missed signal costs freshness, not data.
   */
  emitToRep(repId: string, event: string, payload: unknown): void {
    if (!this.server || !repId) return;
    this.server.to(repRoom(repId)).emit(event, payload);
  }

  /** Send to every connected salesman, but not to dashboard-only sockets. */
  emitToAllReps(event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(REPS_ROOM).emit(event, payload);
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
