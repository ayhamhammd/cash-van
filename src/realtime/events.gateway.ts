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

/**
 * Operational realtime stream for dashboard clients.
 *
 * Single-tenant / single-instance: every authenticated client belongs to the
 * one company, so events are broadcast to all connected sockets. JWT auth is
 * enforced at handshake time — a missing/invalid token disconnects the socket.
 *
 * Client:
 *   const socket = io('http://host/ws/ops', { auth: { token: jwt } });
 *   socket.on('rep.location', (p) => ...);
 */
@WebSocketGateway({ namespace: '/ws/ops', cors: { origin: true, credentials: true } })
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
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
      }) as { sub: string; role?: string };
      client.data.userId = payload.sub;
      client.data.role = payload.role ?? 'viewer';
    } catch {
      this.logger.warn(`WS connection refused (bad token): ${client.id}`);
      client.disconnect(true);
    }
  }

  /** Broadcast an event to every connected dashboard client. */
  broadcast(event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.emit(event, payload);
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
