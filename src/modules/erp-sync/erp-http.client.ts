import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SettingsService } from '../settings/settings.service';

/** Redact + truncate a body for logging. */
function brief(v: unknown, max = 1500): string {
  if (v == null) return '';
  let s: string;
  try {
    s = JSON.stringify(v, (k, val) => (/key|secret|token|password/i.test(k) ? '***' : val));
  } catch {
    return String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…(${s.length}b)` : s;
}

/** ERP list responses are `{ success, data: [...], pagination: { total, ... } }`. */
export interface ErpListResult<T> {
  data: T[];
  total: number;
}

/**
 * Thin client for the erp-saas public API (`{baseUrl}/api/v1/...`). Reads the
 * connection (base URL + decrypted key) from app settings on each call so a
 * config change applies without a restart.
 */
@Injectable()
export class ErpHttpClient {
  private readonly logger = new Logger('ERP-HTTP');
  constructor(
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  /** Per-request timeout (ms), from ERP_HTTP_TIMEOUT_MS. */
  private timeout(): number {
    return this.config.get<number>('erp.httpTimeoutMs', 60000);
  }

  async list<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<ErpListResult<T>> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.baseUrl || !cfg.apiKey) {
      throw new Error('ERP base URL or API key not configured');
    }
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const url = `${base}/api/v1/${path}${qs.toString() ? `?${qs}` : ''}`;
    this.logger.log(`→ GET ${url}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(this.timeout()),
    });
    this.logger.log(`← GET ${path} ${res.status}`);
    if (!res.ok) throw await this.readError(res, path);
    const body: unknown = await res.json();
    const data = this.extractData<T>(body);
    const total = this.extractTotal(body) ?? data.length;
    return { data, total };
  }

  /**
   * GET an ERP endpoint and return the FULL parsed body (not just `data`) — needed when
   * the response carries extra top-level fields (e.g. `/ar/aging`'s `summary`).
   */
  async getJson<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('ERP base URL or API key not configured');
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const url = `${base}/api/v1/${path}${qs.toString() ? `?${qs}` : ''}`;
    this.logger.log(`→ GET ${url}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(this.timeout()),
    });
    this.logger.log(`← GET ${path} ${res.status}`);
    if (!res.ok) throw await this.readError(res, path);
    return (await res.json()) as T;
  }

  /** GET a single ERP resource → unwrap the `data` object (e.g. an invoice detail). */
  async getOne<T>(path: string): Promise<T | null> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('ERP base URL or API key not configured');
    const base = cfg.baseUrl.replace(/\/+$/, '');
    this.logger.log(`→ GET ${base}/api/v1/${path}`);
    const res = await fetch(`${base}/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(this.timeout()),
    });
    this.logger.log(`← GET ${path} ${res.status}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T } | null;
    return body?.data ?? null;
  }

  /**
   * POST to an ERP write endpoint with an Idempotency-Key. Treats a duplicate
   * (HTTP 409 DUPLICATE_EXTERNAL_ID or an idempotent replay) as success, since
   * the document already exists on the ERP — exactly what we want for retries.
   */
  async post(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ ok: boolean; duplicate: boolean; data: unknown; status: number; error?: string }> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.baseUrl || !cfg.apiKey) {
      throw new Error('ERP base URL or API key not configured');
    }
    const base = cfg.baseUrl.replace(/\/+$/, '');
    this.logger.log(`→ POST ${base}/api/v1/${path} body=${brief(body)}`);
    const res = await fetch(`${base}/api/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout()),
    });
    const json: unknown = await res.json().catch(() => null);
    this.logger.log(`← POST ${path} ${res.status} res=${brief(json)}`);
    const code = this.errorCode(json);
    if (res.status === 409 && code === 'DUPLICATE_EXTERNAL_ID') {
      return { ok: true, duplicate: true, data: json, status: res.status };
    }
    if (!res.ok) {
      return {
        ok: false,
        duplicate: false,
        data: json,
        status: res.status,
        error: this.errorDetail(json) ?? code ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true, duplicate: false, data: json, status: res.status };
  }

  /** PATCH an ERP resource (e.g. organization settings). Returns the parsed `data`. */
  async patch<T>(path: string, body: unknown): Promise<T | null> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('ERP base URL or API key not configured');
    const base = cfg.baseUrl.replace(/\/+$/, '');
    this.logger.log(`→ PATCH ${base}/api/v1/${path} body=${brief(body)}`);
    const res = await fetch(`${base}/api/v1/${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout()),
    });
    this.logger.log(`← PATCH ${path} ${res.status}`);
    if (!res.ok) throw new Error(`ERP PATCH ${path} failed (HTTP ${res.status})`);
    const json = (await res.json().catch(() => null)) as { data?: T } | null;
    return json?.data ?? null;
  }

  /**
   * Turn a failed GET into an error an operator can act on.
   *
   * Every non-2xx used to collapse into "ERP rejected the API key (HTTP 401)" or
   * a bare "failed (HTTP 500)", which conflated three different problems with
   * three different fixes: a bad key (re-enter it), a key that is scoped to one
   * warehouse or missing a scope (widen it in the ERP), and a rate-limited sweep
   * (nothing is wrong, it asked too fast). The status code and the ERP's own
   * `error.code` / `error.message` are all already on the wire — they were just
   * being thrown away, and the dashboard's per-entity row is where they belong.
   */
  private async readError(res: Response, path: string): Promise<Error> {
    const json: unknown = await res.json().catch(() => null);
    const code = this.errorCode(json);
    const detail = this.errorDetail(json);
    if (res.status === 401) {
      return new Error(
        `ERP rejected the API key (HTTP 401) on ${path} — the key is wrong, ` +
          'revoked or expired. Re-enter it in Settings → ERP.',
      );
    }
    if (res.status === 403) {
      // WAREHOUSE_FORBIDDEN is by far the common one: a key locked to a single
      // warehouse 403s on every OTHER warehouse's movement feed, while unknown
      // warehouse codes answer 200-empty — so the same key looks half-working.
      return new Error(
        `ERP refused the request (HTTP 403) on ${path}` +
          (detail ? ` — ${detail}` : '') +
          (code === 'WAREHOUSE_FORBIDDEN'
            ? '. The ERP API key is restricted to ONE warehouse; clear that ' +
              'restriction so it can read every store.'
            : '. The API key is missing a scope for this endpoint.'),
      );
    }
    if (res.status === 429) {
      return new Error(
        `ERP rate limit reached (HTTP 429) on ${path} — the sweep asked for too ` +
          'much inside one minute. It will succeed on the next run.',
      );
    }
    return new Error(`ERP ${path} failed (HTTP ${res.status})${detail ? ` — ${detail}` : ''}`);
  }

  /**
   * The ERP error CODE alone — for branching (DUPLICATE_EXTERNAL_ID, 429…).
   */
  private errorCode(json: unknown): string | null {
    if (json && typeof json === 'object') {
      const err = (json as Record<string, unknown>).error;
      if (err && typeof err === 'object') {
        const c = (err as Record<string, unknown>).code;
        if (typeof c === 'string') return c;
      }
    }
    return null;
  }

  /**
   * Code PLUS the ERP's own explanation, for the operator reading a dead-letter.
   *
   * A bare "VALIDATION_ERROR" is unactionable — it says a field is wrong without
   * saying which. The ERP already sends `error.message` ("code: Required") and
   * often `error.details`; both were being discarded, so seven invoices sat dead
   * with an error nobody could diagnose without replaying the request by hand.
   */
  private errorDetail(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const err = (json as Record<string, unknown>).error;
    if (!err || typeof err !== 'object') return null;
    const e = err as Record<string, unknown>;
    const code = typeof e.code === 'string' ? e.code : null;
    const message = typeof e.message === 'string' ? e.message : null;
    const details = Array.isArray(e.details) && e.details.length
      ? ` — ${JSON.stringify(e.details).slice(0, 300)}`
      : '';
    if (!code && !message) return null;
    return `${code ?? 'ERROR'}${message ? `: ${message}` : ''}${details}`;
  }

  private extractData<T>(body: unknown): T[] {
    if (Array.isArray(body)) return body as T[];
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      if (Array.isArray(o.data)) return o.data as T[];
      if (Array.isArray(o.items)) return o.items as T[];
    }
    return [];
  }

  private extractTotal(body: unknown): number | null {
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      const pg = o.pagination as Record<string, unknown> | undefined;
      if (pg && typeof pg.total === 'number') return pg.total;
      if (typeof o.total === 'number') return o.total;
    }
    return null;
  }
}
