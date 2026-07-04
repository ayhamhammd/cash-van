import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from '../settings/settings.service';

export interface HubPostResult {
  ok: boolean;
  duplicate: boolean;
  data: unknown;
  status: number;
  error?: string;
}

/**
 * POSTs van documents to the ERP Integration Hub sync endpoints
 * (`{hubBaseUrl}/api/sync/<path>`), authenticated with the partner's VAN_SALES
 * bearer secret. `partnerId` is injected into every body. Mirrors
 * {@link ErpHttpClient.post}'s result shape so the outbox can treat both the
 * same. See docs/SPEC-integration-hub.md.
 */
@Injectable()
export class HubHttpClient {
  private readonly logger = new Logger(HubHttpClient.name);

  constructor(private readonly settings: SettingsService) {}

  /** True when the Hub is enabled AND fully configured (base URL + partner + secret). */
  async isActive(): Promise<boolean> {
    const cfg = await this.settings.getHubConfig();
    return !!(cfg.enabled && cfg.baseUrl && cfg.partnerId && cfg.syncSecret);
  }

  async postSync(
    path: string,
    body: Record<string, unknown>,
  ): Promise<HubPostResult> {
    const cfg = await this.settings.getHubConfig();
    if (!cfg.enabled) {
      return { ok: false, duplicate: false, data: null, status: 0, error: 'hub_disabled' };
    }
    if (!cfg.baseUrl || !cfg.partnerId || !cfg.syncSecret) {
      return { ok: false, duplicate: false, data: null, status: 0, error: 'hub_not_configured' };
    }

    const base = cfg.baseUrl.replace(/\/+$/, '');
    const url = `${base}/api/sync/${path}`;
    const payload = { partnerId: cfg.partnerId, ...body };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.syncSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Hub unreachable';
      this.logger.warn(`→ POST hub/${path} network error: ${error}`);
      return { ok: false, duplicate: false, data: null, status: 0, error };
    }

    const json: unknown = await res.json().catch(() => null);
    this.logger.log(`← POST hub/${path} ${res.status}`);

    // Replay: the Hub returns 200 with { duplicate: true, targetDocumentNumber }.
    if (res.ok && isDuplicate(json)) {
      return { ok: true, duplicate: true, data: json, status: res.status };
    }
    if (!res.ok) {
      const err = errorMessageOf(json) ?? `HTTP ${res.status}`;
      return { ok: false, duplicate: false, data: json, status: res.status, error: err };
    }
    return { ok: true, duplicate: false, data: json, status: res.status };
  }
}

function isDuplicate(json: unknown): boolean {
  return (
    !!json &&
    typeof json === 'object' &&
    (json as Record<string, unknown>).duplicate === true
  );
}

function errorMessageOf(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const err = (json as Record<string, unknown>).error;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message ?? (err as Record<string, unknown>).code;
      if (typeof m === 'string') return m;
    }
  }
  return null;
}
