import { Injectable } from '@nestjs/common';

import { SettingsService } from '../settings/settings.service';

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
  constructor(private readonly settings: SettingsService) {}

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
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`ERP rejected the API key (HTTP ${res.status}) on ${path}`);
    }
    if (!res.ok) {
      throw new Error(`ERP ${path} failed (HTTP ${res.status})`);
    }
    const body: unknown = await res.json();
    const data = this.extractData<T>(body);
    const total = this.extractTotal(body) ?? data.length;
    return { data, total };
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
    const res = await fetch(`${base}/api/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const json: unknown = await res.json().catch(() => null);
    const code = this.errorCode(json);
    if (res.status === 409 && code === 'DUPLICATE_EXTERNAL_ID') {
      return { ok: true, duplicate: true, data: json, status: res.status };
    }
    if (!res.ok) {
      return { ok: false, duplicate: false, data: json, status: res.status, error: code ?? `HTTP ${res.status}` };
    }
    return { ok: true, duplicate: false, data: json, status: res.status };
  }

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
