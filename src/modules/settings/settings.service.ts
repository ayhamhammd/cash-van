import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';

import { AppSettings, TaxCalcMethod } from './entities/app-settings.entity';
import { UpdateAppSettingsDto } from './dto/update-settings.dto';
import { UpdateJoFotaraDto } from './dto/update-jofotara.dto';
import { UpdateErpDto } from './dto/update-erp.dto';
import { decryptSecret, encryptSecret, maskSecret } from '../../common/crypto/secret.util';
import { UserContextService } from '../../common/context/user-context.service';

export interface AppSettingsView {
  companyNumber: string;
  logoUrl: string | null;
  companyNameAr: string;
  companyNameEn: string | null;
  sellerTin: string | null;
  sellerAddress: string | null;
  sellerPhone: string | null;
  sellerCityCode: string | null;
  taxCalcMethod: TaxCalcMethod;
  timezone: string;
  locale: string;
  aiChatQuota: number;
  aiInferQuota: number;
  jofotara: {
    clientId: string | null;
    secretLast4: string | null;
    sandbox: boolean;
    isConfigured: boolean;
  };
  erp: {
    enabled: boolean;
    baseUrl: string | null;
    apiKeyLast4: string | null;
    isConfigured: boolean;
    lastSyncAt: Date | null;
    vanStore: string | null;
    directExport: boolean;
  };
  updatedAt: Date;
  updatedBy: string | null;
}

export type ErpView = AppSettingsView['erp'];

export interface JoFotaraUpdateView {
  clientId: string;
  secretLast4: string;
  sandbox: boolean;
  updatedAt: Date;
}

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(AppSettings)
    private readonly repo: Repository<AppSettings>,
    private readonly userCtx: UserContextService,
    private readonly events: EventEmitter2,
  ) {}

  /** Internal: seller identity for JoFotara `accountingSupplierParty`. */
  async getSellerInfo(): Promise<{
    tin: string | null;
    nameAr: string;
    nameEn: string | null;
    address: string | null;
    phone: string | null;
    cityCode: string | null;
  }> {
    const row = await this.requireRow();
    return {
      tin: row.sellerTin ?? null,
      nameAr: row.companyNameAr,
      nameEn: row.companyNameEn ?? null,
      address: row.sellerAddress ?? null,
      phone: row.sellerPhone ?? null,
      cityCode: row.sellerCityCode ?? null,
    };
  }

  /** Internal: decrypted JoFotara credentials for the ISTD client. */
  async getJoFotaraCredentials(): Promise<{
    clientId: string | null;
    secretKey: string | null;
    sandbox: boolean;
  }> {
    const row = await this.repo
      .createQueryBuilder('s')
      .addSelect('s.jofotaraSecretKeyEncrypted')
      .where('s.id = 1')
      .getOne();
    if (!row) throw new NotFoundException('app_settings row missing — re-run migrations');
    let secretKey: string | null = null;
    if (row.jofotaraSecretKeyEncrypted) {
      secretKey = decryptSecret(row.jofotaraSecretKeyEncrypted);
    }
    return {
      clientId: row.jofotaraClientId ?? null,
      secretKey,
      sandbox: row.jofotaraSandbox,
    };
  }

  async get(): Promise<AppSettingsView> {
    const row = await this.repo.findOne({ where: { id: 1 } });
    if (!row) throw new NotFoundException('app_settings row missing — re-run migrations');
    return this.toView(row);
  }

  async update(dto: UpdateAppSettingsDto): Promise<AppSettingsView> {
    const row = await this.requireRow();
    Object.assign(row, dto);
    row.updatedBy = this.userCtx.getUserId();
    await this.repo.save(row);
    // Mirror company name + tax mode to the ERP (ErpSyncService listener; no-op when ERP off).
    this.events.emit('erp.settings.updated', {
      name: row.companyNameEn || row.companyNameAr,
      salesTaxMode: row.taxCalcMethod,
      logoUrl: row.logoUrl ?? null,
      address: row.sellerAddress ?? null,
      phone: row.sellerPhone ?? null,
      taxNumber: row.sellerTin ?? null,
    });
    return this.toView(row);
  }

  /**
   * Apply company name + tax mode pulled FROM the ERP. Writes the row directly
   * (no 'erp.settings.updated' event) so an inbound pull never echoes back out.
   * The Arabic name is only set when currently empty (don't clobber a curated one).
   */
  async applyErpOrg(org: {
    name?: string | null;
    salesTaxMode?: string | null;
    logoUrl?: string | null;
    address?: string | null;
    phone?: string | null;
    taxNumber?: string | null;
  }): Promise<void> {
    const row = await this.requireRow();
    let changed = false;
    if (org.name) {
      if (row.companyNameEn !== org.name) { row.companyNameEn = org.name; changed = true; }
      if (!row.companyNameAr) { row.companyNameAr = org.name; changed = true; }
    }
    if (org.salesTaxMode === 'EXCLUSIVE' || org.salesTaxMode === 'INCLUSIVE') {
      if (row.taxCalcMethod !== org.salesTaxMode) { row.taxCalcMethod = org.salesTaxMode; changed = true; }
    }
    if (org.logoUrl && row.logoUrl !== org.logoUrl) { row.logoUrl = org.logoUrl; changed = true; }
    if (org.address != null && row.sellerAddress !== org.address) { row.sellerAddress = org.address; changed = true; }
    if (org.phone != null && row.sellerPhone !== org.phone) { row.sellerPhone = org.phone; changed = true; }
    if (org.taxNumber != null && row.sellerTin !== org.taxNumber) { row.sellerTin = org.taxNumber; changed = true; }
    if (changed) await this.repo.save(row);
  }

  /**
   * Store an uploaded company logo. The image is kept inline as a base64 data
   * URL on the single settings row, so it survives redeploys without any object
   * storage / writable-disk dependency (deployments use an ephemeral filesystem).
   */
  async setLogo(file: Express.Multer.File): Promise<AppSettingsView> {
    const row = await this.requireRow();
    row.logoUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    row.updatedBy = this.userCtx.getUserId();
    await this.repo.save(row);
    return this.toView(row);
  }

  async updateJoFotara(dto: UpdateJoFotaraDto): Promise<JoFotaraUpdateView> {
    const row = await this.requireRow();
    row.jofotaraClientId = dto.clientId;
    row.jofotaraSecretKeyEncrypted = encryptSecret(dto.secretKey);
    row.jofotaraSecretLast4 = maskSecret(dto.secretKey).slice(-4);
    if (dto.sandbox !== undefined) row.jofotaraSandbox = dto.sandbox;
    row.updatedBy = this.userCtx.getUserId();
    await this.repo.save(row);

    return {
      clientId: dto.clientId,
      secretLast4: row.jofotaraSecretLast4,
      sandbox: row.jofotaraSandbox,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Lightweight company profile for the app (any authenticated user) — no secrets,
   * no ERP/JoFotara/AI internals. Includes taxCalcMethod so the app's offline
   * money engine uses the SAME inclusive/exclusive mode as the dashboard.
   */
  async getCompanyInfo(): Promise<{
    companyNameAr: string;
    companyNameEn: string | null;
    sellerTin: string | null;
    sellerAddress: string | null;
    sellerPhone: string | null;
    sellerCityCode: string | null;
    logoUrl: string | null;
    taxCalcMethod: TaxCalcMethod;
    timezone: string;
    locale: string;
  }> {
    const row = await this.requireRow();
    return {
      companyNameAr: row.companyNameAr,
      companyNameEn: row.companyNameEn ?? null,
      sellerTin: row.sellerTin ?? null,
      sellerAddress: row.sellerAddress ?? null,
      sellerPhone: row.sellerPhone ?? null,
      sellerCityCode: row.sellerCityCode ?? null,
      logoUrl: row.logoUrl ?? null,
      taxCalcMethod: row.taxCalcMethod,
      timezone: row.timezone,
      locale: row.locale,
    };
  }

  private async requireRow(): Promise<AppSettings> {
    const row = await this.repo.findOne({ where: { id: 1 } });
    if (!row) throw new NotFoundException('app_settings row missing — re-run migrations');
    return row;
  }

  private toView(row: AppSettings): AppSettingsView {
    return {
      companyNumber: row.companyNumber,
      logoUrl: row.logoUrl ?? null,
      companyNameAr: row.companyNameAr,
      companyNameEn: row.companyNameEn ?? null,
      sellerTin: row.sellerTin ?? null,
      sellerAddress: row.sellerAddress ?? null,
      sellerPhone: row.sellerPhone ?? null,
      sellerCityCode: row.sellerCityCode ?? null,
      taxCalcMethod: row.taxCalcMethod,
      timezone: row.timezone,
      locale: row.locale,
      aiChatQuota: row.aiChatQuota,
      aiInferQuota: row.aiInferQuota,
      jofotara: {
        clientId: row.jofotaraClientId ?? null,
        secretLast4: row.jofotaraSecretLast4 ?? null,
        sandbox: row.jofotaraSandbox,
        isConfigured: !!row.jofotaraClientId && !!row.jofotaraSecretLast4,
      },
      erp: {
        enabled: row.erpSyncEnabled,
        baseUrl: row.erpBaseUrl ?? null,
        apiKeyLast4: row.erpApiKeyLast4 ?? null,
        isConfigured: !!row.erpBaseUrl && !!row.erpApiKeyLast4,
        lastSyncAt: row.erpLastSyncAt ?? null,
        vanStore: row.erpVanStore ?? null,
        directExport: row.erpDirectExport ?? true,
      },
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ?? null,
    };
  }

  /** Set the ERP toggle + connection. The API key is encrypted; omit it to keep the current one. */
  async updateErp(dto: UpdateErpDto): Promise<ErpView> {
    const row = await this.requireRow();
    row.erpSyncEnabled = dto.enabled;
    if (dto.baseUrl !== undefined) {
      // Store the ORIGIN only — the HTTP client appends `/api/v1/...` itself, so
      // strip a pasted `/api/v1` (or `/api`) suffix and any trailing slash.
      row.erpBaseUrl =
        dto.baseUrl
          .trim()
          .replace(/\/+$/, '')
          .replace(/\/api(\/v\d+)?$/i, '') || null;
    }
    if (dto.apiKey) {
      row.erpApiKeyEncrypted = encryptSecret(dto.apiKey);
      row.erpApiKeyLast4 = maskSecret(dto.apiKey).slice(-4);
    }
    if (dto.vanStore !== undefined) row.erpVanStore = dto.vanStore.trim() || null;
    if (dto.defaultCategoryId !== undefined)
      row.erpDefaultCategoryId = dto.defaultCategoryId.trim() || null;
    if (dto.defaultTaxRateId !== undefined)
      row.erpDefaultTaxRateId = dto.defaultTaxRateId.trim() || null;
    if (dto.directExport !== undefined) row.erpDirectExport = dto.directExport;
    row.updatedBy = this.userCtx.getUserId();
    await this.repo.save(row);
    // On (re)connect, immediately pull company info from the ERP organization —
    // don't wait for the 60s sync cycle. ErpSyncService listens. (erpApiKeyEncrypted
    // is select:false so it's absent here; erpApiKeyLast4 signals a key is set.)
    if (row.erpSyncEnabled && row.erpBaseUrl && (dto.apiKey || row.erpApiKeyLast4)) {
      this.events.emit('erp.connected');
    }
    return {
      enabled: row.erpSyncEnabled,
      baseUrl: row.erpBaseUrl ?? null,
      apiKeyLast4: row.erpApiKeyLast4 ?? null,
      isConfigured: !!row.erpBaseUrl && !!row.erpApiKeyLast4,
      lastSyncAt: row.erpLastSyncAt ?? null,
      vanStore: row.erpVanStore ?? null,
      directExport: row.erpDirectExport ?? true,
    };
  }

  /** Internal: decrypted ERP connection for the sync engine. */
  async getErpConfig(): Promise<{
    enabled: boolean;
    baseUrl: string | null;
    apiKey: string | null;
    vanStore: string | null;
    defaultCategoryId: string | null;
    defaultTaxRateId: string | null;
    directExport: boolean;
  }> {
    const row = await this.repo
      .createQueryBuilder('s')
      .addSelect('s.erpApiKeyEncrypted')
      .where('s.id = 1')
      .getOne();
    if (!row) throw new NotFoundException('app_settings row missing — re-run migrations');
    return {
      enabled: row.erpSyncEnabled,
      baseUrl: row.erpBaseUrl ?? null,
      apiKey: row.erpApiKeyEncrypted ? decryptSecret(row.erpApiKeyEncrypted) : null,
      vanStore: row.erpVanStore ?? null,
      defaultCategoryId: row.erpDefaultCategoryId ?? null,
      defaultTaxRateId: row.erpDefaultTaxRateId ?? null,
      directExport: row.erpDirectExport ?? true,
    };
  }

  /** Probe the ERP with the stored credentials (health + a 1-row catalog read). */
  async testErp(): Promise<{ ok: boolean; message: string }> {
    const cfg = await this.getErpConfig();
    if (!cfg.baseUrl || !cfg.apiKey) {
      return { ok: false, message: 'ERP base URL or API key not configured' };
    }
    const base = cfg.baseUrl.replace(/\/+$/, '');
    try {
      const health = await fetch(`${base}/api/v1/health`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!health.ok) {
        return { ok: false, message: `Health check failed (HTTP ${health.status})` };
      }
      const skus = await fetch(`${base}/api/v1/skus?pageSize=1`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (skus.status === 401 || skus.status === 403) {
        return { ok: false, message: 'API key rejected by the ERP (check key/scopes)' };
      }
      if (!skus.ok) {
        return { ok: false, message: `Catalog read failed (HTTP ${skus.status})` };
      }
      return { ok: true, message: 'Connected to the ERP successfully' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'ERP unreachable' };
    }
  }
}
