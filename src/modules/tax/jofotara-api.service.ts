import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';

export interface JoFotaraResponse {
  success: boolean;
  qrCode?: string;
  registrationNumber?: string;
  errorCode?: string;
  errorMessage?: string;
  requestUrl?: string;
  responseStatus?: number;
  responseBody?: Record<string, unknown>;
  durationMs: number;
}

export interface JoFotaraCredentials {
  clientId: string | null;
  secretKey: string | null;
  sandbox: boolean;
}

/**
 * ISTD JoFotara HTTP client (port of spec §7).
 *
 * Mock mode (default, `JOFOTARA_MOCK=true`): returns a deterministic VALIDATED
 * response with a fake QR — lets the whole submission pipeline run + be tested
 * without real ISTD access. The request payload is still built and returned so
 * the builder output is exercised.
 *
 * Live mode (`JOFOTARA_MOCK=false` + credentials present): real axios POST to
 * the sandbox/prod base URL. NOTE: the ISTD endpoint path/contract should be
 * verified against official docs before relying on live mode.
 */
@Injectable()
export class JoFotaraApiService {
  private readonly logger = new Logger(JoFotaraApiService.name);

  constructor(private readonly config: ConfigService) {}

  private get mockMode(): boolean {
    return this.config.get<boolean>('jofotara.mock', true);
  }

  async submit(
    payload: Record<string, unknown>,
    creds: JoFotaraCredentials,
  ): Promise<JoFotaraResponse> {
    const started = Date.now();
    const baseUrl = creds.sandbox
      ? 'https://jofotara-sandbox.gov.jo/api/v1'
      : 'https://jofotara.gov.jo/api/v1';
    const url = `${baseUrl}/invoice`;

    if (this.mockMode || !creds.clientId || !creds.secretKey) {
      // Deterministic stand-in; pipeline behaves as if ISTD validated it.
      return {
        success: true,
        qrCode: `MOCK-QR-${randomUUID()}`,
        registrationNumber: `MOCK-REG-${Date.now()}`,
        requestUrl: `${url} (mock)`,
        responseStatus: 200,
        responseBody: { mock: true },
        durationMs: Date.now() - started,
      };
    }

    try {
      const { data, status } = await axios.post(url, payload, {
        timeout: 30_000,
        headers: {
          'Content-Type': 'application/json',
          clientId: creds.clientId,
          secretKey: creds.secretKey,
        },
      });
      return {
        success: true,
        qrCode: (data as { qrCode?: string }).qrCode,
        registrationNumber: (data as { registrationNumber?: string }).registrationNumber,
        requestUrl: url,
        responseStatus: status,
        responseBody: data as Record<string, unknown>,
        durationMs: Date.now() - started,
      };
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const data = (err.response?.data ?? {}) as Record<string, unknown>;
        return {
          success: false,
          errorCode: (data.errorCode as string) ?? err.code ?? 'HTTP_ERROR',
          errorMessage: (data.errorMessage as string) ?? err.message,
          requestUrl: url,
          responseStatus: err.response?.status,
          responseBody: data,
          durationMs: Date.now() - started,
        };
      }
      return {
        success: false,
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: String(err),
        requestUrl: url,
        durationMs: Date.now() - started,
      };
    }
  }
}
