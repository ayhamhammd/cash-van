import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppSettings, TaxCalcMethod } from './entities/app-settings.entity';
import { UpdateAppSettingsDto } from './dto/update-settings.dto';
import { UpdateJoFotaraDto } from './dto/update-jofotara.dto';
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
  updatedAt: Date;
  updatedBy: string | null;
}

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
    return this.toView(row);
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
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ?? null,
    };
  }
}
