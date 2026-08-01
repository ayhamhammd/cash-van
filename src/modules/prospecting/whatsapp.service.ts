import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Outcome of one send, as surfaced to the caller. */
export interface WhatsappSendResult {
  chatId: string;
  /** Gateway's own message id, when it returns one. */
  messageId: string | null;
}

export interface WhatsappStatus {
  configured: boolean;
  /** Gateway answered an HTTP request. */
  reachable: boolean;
  /** Gateway's session state string, e.g. "CONNECTED". Null if unknown. */
  session: string | null;
  sentToday: number;
  dailyCap: number;
  minIntervalMs: number;
  /** Why it isn't usable, when it isn't. */
  detail: string | null;
}

/**
 * Client for a self-hosted OpenWA gateway (github.com/rmyndharis/OpenWA).
 *
 * OpenWA drives an UNOFFICIAL WhatsApp Web session, so the number behind it can
 * be permanently restricted with no appeal — and its own docs name cold-blasting
 * numbers that never messaged you as the single most reliable way to trigger
 * that. Two guards live here rather than in the caller, so no code path can skip
 * them:
 *
 *   1. Sends are SERIALIZED through one promise chain with a minimum gap plus
 *      jitter, so bursts become a trickle no matter how fast the UI clicks.
 *   2. A per-day counter hard-stops the process at `dailyCap`.
 *
 * Both are per-process. A multi-replica deployment would need the counter in
 * Redis — noted rather than solved, because this backend runs single-replica.
 */
@Injectable()
export class WhatsappService {
  private readonly log = new Logger(WhatsappService.name);

  /** Tail of the send chain — awaiting it means "everyone before me is done". */
  private chain: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;
  private sentToday = 0;
  private dayKey = '';

  constructor(private readonly config: ConfigService) {}

  private cfg<T>(key: string): T {
    return this.config.get<T>(`whatsapp.${key}`) as T;
  }

  get isConfigured(): boolean {
    return !!this.cfg<string>('baseUrl') && !!this.cfg<string>('sessionId');
  }

  /**
   * `{digits}@c.us`, the only chatId shape the gateway accepts.
   *
   * Jordanian numbers arrive from Google Places in several shapes — "07 7212
   * 8611", "+962 7 7212 8611", "(06) 461 4846" — and all must land on the same
   * chatId. A leading "+" or "00" means the digits are already international
   * and must NOT be prefixed again.
   */
  toChatId(raw: string | null | undefined): string {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) throw new BadRequestException('No phone number to message');

    const cc = this.cfg<string>('countryCode') || '962';
    const international = trimmed.startsWith('+') || /^00\d/.test(trimmed);
    let d = trimmed.replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);

    if (!international) {
      // A local number: drop the trunk "0" and prefix the country code. Numbers
      // that already carry the country code are left alone.
      if (d.startsWith('0')) d = cc + d.replace(/^0+/, '');
      else if (!d.startsWith(cc)) d = cc + d;
    }

    // 8 is shorter than any real MSISDN; 15 is the E.164 ceiling.
    if (d.length < 8 || d.length > 15) {
      throw new BadRequestException(`Phone number looks invalid: ${trimmed}`);
    }
    return `${d}@c.us`;
  }

  /** Snapshot for the dashboard — never throws, so the UI can always render. */
  async status(): Promise<WhatsappStatus> {
    const base: WhatsappStatus = {
      configured: this.isConfigured,
      reachable: false,
      session: null,
      sentToday: this.today() ? this.sentToday : 0,
      dailyCap: this.cfg<number>('dailyCap'),
      minIntervalMs: this.cfg<number>('minIntervalMs'),
      detail: null,
    };
    if (!this.isConfigured) {
      return { ...base, detail: 'WHATSAPP_GATEWAY_URL / SESSION_ID not set' };
    }
    try {
      const res = await this.call('GET', `/api/sessions/${this.sessionId()}`);
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        state?: string;
        data?: { status?: string; state?: string };
      };
      const session =
        body.status ?? body.state ?? body.data?.status ?? body.data?.state ?? null;
      return {
        ...base,
        reachable: res.ok,
        session,
        detail: res.ok ? null : `Gateway returned ${res.status}`,
      };
    } catch (e) {
      return { ...base, detail: `Gateway unreachable: ${String(e)}` };
    }
  }

  /**
   * Queue one text message. Resolves only once it has actually been handed to
   * the gateway, so the caller can mark the prospect contacted with confidence.
   */
  async sendText(phone: string | null | undefined, text: string): Promise<WhatsappSendResult> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'WhatsApp gateway is not configured — set WHATSAPP_GATEWAY_URL and WHATSAPP_SESSION_ID',
      );
    }
    if (!text.trim()) throw new BadRequestException('Message body is empty');

    // Validate before queueing: a bad number should fail now, not after a
    // 20-second wait behind other sends.
    const chatId = this.toChatId(phone);

    const run = this.chain.then(
      () => this.paced(chatId, text),
      () => this.paced(chatId, text), // a prior failure must not poison the chain
    );
    // Keep the chain alive regardless of this send's outcome.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Enforces the gap and the daily cap, then performs the HTTP send. */
  private async paced(chatId: string, text: string): Promise<WhatsappSendResult> {
    if (!this.today()) {
      this.dayKey = new Date().toISOString().slice(0, 10);
      this.sentToday = 0;
    }
    const cap = this.cfg<number>('dailyCap');
    if (this.sentToday >= cap) {
      throw new HttpException(
        `WhatsApp daily cap reached (${cap}). This protects the number from being restricted.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const min = this.cfg<number>('minIntervalMs');
    // ±20% jitter — a perfectly regular cadence is itself a bot signal.
    const gap = min + Math.floor(Math.random() * min * 0.4) - min * 0.2;
    const wait = this.lastSentAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const res = await this.call('POST', `/api/sessions/${this.sessionId()}/messages/send-text`, {
      chatId,
      text,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.error(`OpenWA send ${res.status}: ${body.slice(0, 400)}`);
      throw this.mapError(res.status, body);
    }

    this.lastSentAt = Date.now();
    this.sentToday += 1;

    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      messageId?: string;
      data?: { id?: string; messageId?: string };
    };
    return {
      chatId,
      messageId:
        json.id ?? json.messageId ?? json.data?.id ?? json.data?.messageId ?? null,
    };
  }

  private sessionId(): string {
    return this.cfg<string>('sessionId');
  }

  private call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${this.cfg<string>('baseUrl')}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.cfg<string>('apiKey'),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /** Turn the gateway's status codes into something an operator can act on. */
  private mapError(status: number, body: string): Error {
    if (status === 401 || status === 403) {
      return new ServiceUnavailableException(
        'WhatsApp gateway rejected the API key — check WHATSAPP_API_KEY',
      );
    }
    if (status === 404) {
      return new ServiceUnavailableException(
        `WhatsApp session "${this.sessionId()}" not found on the gateway — create and scan it first`,
      );
    }
    if (status === 409 || status === 422 || status === 503) {
      return new ServiceUnavailableException(
        'WhatsApp session is not connected — open the OpenWA dashboard and re-scan the QR code',
      );
    }
    if (status === 429) {
      return new HttpException(
        'WhatsApp gateway is rate-limiting sends',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new BadGatewayException(`WhatsApp send failed (${status}): ${body.slice(0, 200)}`);
  }

  private today(): boolean {
    return this.dayKey === new Date().toISOString().slice(0, 10);
  }
}
