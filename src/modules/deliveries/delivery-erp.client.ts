import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

import { ErpHttpClient } from '../erp-sync/erp-http.client';
import { SettingsService } from '../settings/settings.service';
import {
  erpErrorCode,
  erpErrorMessage,
  erpRefusals,
  erpWarnings,
  unwrapList,
  unwrapRun,
  type ErpDeliveryRun,
  type ErpLoadWarning,
  type ErpVehicle,
} from './erp-delivery.types';

/** The ERP is not there: unconfigured, switched off, unreachable or unwell (5xx). */
export class ErpUnavailableError extends HttpException {
  constructor(detail?: string) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'ERP_UNAVAILABLE',
        message: detail ? `The ERP is unavailable: ${detail}` : 'The ERP is unavailable',
        error: 'ErpUnavailable',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * The ERP answered and refused. Passed through to the dashboard with the ERP's
 * code: 422 `{ code: 'LOAD_REFUSED', refusals }`, 409 `{ code }` and so on.
 */
export class ErpRefusedError extends HttpException {
  constructor(
    readonly erpStatus: number,
    readonly erpCode: string,
    message: string,
    refusals?: unknown[],
  ) {
    const status = ErpRefusedError.statusFor(erpStatus);
    super(
      {
        statusCode: status,
        code: erpCode,
        message,
        error: 'ErpRefused',
        ...(refusals && refusals.length ? { refusals } : {}),
      },
      status,
    );
  }

  /** 404/409/422/400 pass through as they are; any other 4xx is a 422. */
  static statusFor(erpStatus: number): number {
    return [400, 404, 409, 422].includes(erpStatus) ? erpStatus : HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

export interface CreateRunInput {
  externalId: string;
  driverSalesmanCode: string;
  vehicleId?: string;
  runDate?: string;
  invoiceNumbers: string[];
  notes?: string;
}

export interface PatchRunInput {
  addInvoiceNumbers?: string[];
  removeItemIds?: string[];
  order?: string[];
  driverSalesmanCode?: string;
  vehicleId?: string | null;
  notes?: string;
}

/**
 * The ERP's delivery-runs API (contract §A), over the shared ERP http client
 * and its settings-backed configuration.
 *
 * Every call either returns the ERP's answer or throws one of two things: an
 * ErpUnavailableError (nothing usable came back) or an ErpRefusedError (the ERP
 * said no, with its code). Both are HttpExceptions, so a dashboard route can let
 * them through as they are.
 */
@Injectable()
export class DeliveryErpClient {
  private readonly logger = new Logger(DeliveryErpClient.name);

  constructor(
    private readonly http: ErpHttpClient,
    private readonly settings: SettingsService,
  ) {}

  /** True when ERP sync is switched on and has a URL and a key. */
  async isEnabled(): Promise<boolean> {
    const cfg = await this.settings.getErpConfig().catch(() => null);
    return !!(cfg?.enabled && cfg.baseUrl && cfg.apiKey);
  }

  /**
   * Every run updated at or after `updatedSince` (inclusive; all pages),
   * ordered by updatedAt then id. `updatedSince` is the ERP's own opaque
   * updatedAt string, passed back unchanged.
   */
  async listRunsSince(updatedSince?: string): Promise<ErpDeliveryRun[]> {
    const { data } = await this.http.listAll<ErpDeliveryRun>(
      'delivery-runs',
      updatedSince ? { updatedSince } : {},
    );
    return data
      .filter((r) => r && (typeof r.id === 'string' || typeof r.id === 'number'))
      .map((r) => ({ ...r, id: String(r.id) }));
  }

  /** One run, or null when the ERP no longer has it (404). */
  async getRun(erpId: string): Promise<ErpDeliveryRun | null> {
    const res = await this.call('GET', `delivery-runs/${encodeURIComponent(erpId)}`);
    if (res.status === 404) return null;
    this.assertOk(res);
    return unwrapRun(res.data);
  }

  /** A replay of the same externalId answers 200 `duplicate: true` — the same as a 201. */
  async createRun(
    body: CreateRunInput,
  ): Promise<{ run: ErpDeliveryRun | null; warnings: ErpLoadWarning[] }> {
    const res = await this.call('POST', 'delivery-runs', body, body.externalId);
    this.assertOk(res);
    return { run: unwrapRun(res.data), warnings: erpWarnings(res.data) };
  }

  async patchRun(
    erpId: string,
    body: PatchRunInput,
  ): Promise<{ run: ErpDeliveryRun | null; warnings: ErpLoadWarning[] }> {
    const res = await this.call('PATCH', `delivery-runs/${encodeURIComponent(erpId)}`, body);
    this.assertOk(res);
    return { run: unwrapRun(res.data), warnings: erpWarnings(res.data) };
  }

  async closeRun(erpId: string): Promise<ErpDeliveryRun | null> {
    const res = await this.call('POST', `delivery-runs/${encodeURIComponent(erpId)}/close`, {});
    this.assertOk(res);
    return unwrapRun(res.data);
  }

  async vehicles(): Promise<ErpVehicle[]> {
    const res = await this.call('GET', 'vehicles');
    this.assertOk(res);
    return unwrapList<ErpVehicle>(res.data)
      .filter((v) => v && v.id != null)
      .map((v) => ({ ...v, id: String(v.id) }));
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    if (!(await this.isEnabled())) {
      throw new ErpUnavailableError('ERP sync is switched off or not configured');
    }
    let res: { ok: boolean; status: number; data: unknown };
    try {
      res = await this.http.send(method, path, { body, idempotencyKey });
    } catch (e) {
      // No answer at all: refused connection, DNS, timeout.
      const detail = e instanceof Error ? e.message : String(e);
      this.logger.warn(`${method} ${path}: ${detail}`);
      throw new ErpUnavailableError(detail);
    }
    return res;
  }

  /** 2xx passes; 5xx/408/401/403/429 are "unavailable"; any other refusal carries its code. */
  private assertOk(res: { ok: boolean; status: number; data: unknown }): void {
    if (res.ok) return;
    const code = erpErrorCode(res.data);
    const message = erpErrorMessage(res.data);
    if (
      res.status >= 500 ||
      res.status === 408 ||
      res.status === 429 ||
      res.status === 401 ||
      res.status === 403
    ) {
      throw new ErpUnavailableError(`HTTP ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`);
    }
    const refusals = erpRefusals(res.data);
    throw new ErpRefusedError(
      res.status,
      code ?? `HTTP_${res.status}`,
      message ?? code ?? `The ERP refused the request (HTTP ${res.status})`,
      refusals,
    );
  }
}
