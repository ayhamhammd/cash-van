import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { SettingsService } from '../settings/settings.service';
import { ErpHttpClient } from './erp-http.client';
import { ErpIdMap } from './entities/erp-id-map.entity';
import { ErpSyncCursor } from './entities/erp-sync-cursor.entity';

/** A SKU row from the ERP `GET /api/v1/skus` (prices already in major units). */
interface ErpSku {
  id: string;
  sku: string;
  label?: string;
  barcode?: string | null;
  sellingPrice?: number | string;
  productName?: string;
  isActive?: boolean;
}

export interface SyncEntityResult {
  entity: string;
  count: number;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}

@Injectable()
export class ErpSyncService {
  private readonly logger = new Logger(ErpSyncService.name);

  constructor(
    private readonly erp: ErpHttpClient,
    private readonly settings: SettingsService,
    @InjectRepository(ItemCart) private readonly items: Repository<ItemCart>,
    @InjectRepository(ErpIdMap) private readonly idmap: Repository<ErpIdMap>,
    @InjectRepository(ErpSyncCursor) private readonly cursors: Repository<ErpSyncCursor>,
  ) {}

  /** Per-entity cursor + last-run summary for the dashboard. */
  status(): Promise<ErpSyncCursor[]> {
    return this.cursors.find();
  }

  /** Run an inbound pull now (admin "Sync now"). No-op when ERP mode is off. */
  async syncNow(): Promise<SyncEntityResult[]> {
    const cfg = await this.settings.getErpConfig();
    if (!cfg.enabled) {
      return [{ entity: 'all', count: 0, status: 'skipped', error: 'ERP mode is off' }];
    }
    return [await this.runEntity('item', () => this.pullItems())];
  }

  private async runEntity(
    entity: string,
    fn: () => Promise<number>,
  ): Promise<SyncEntityResult> {
    try {
      const count = await fn();
      await this.saveCursor(entity, 'ok', count, null);
      return { entity, count, status: 'ok' };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.warn(`ERP sync ${entity} failed: ${error}`);
      await this.saveCursor(entity, 'failed', 0, error);
      return { entity, count: 0, status: 'failed', error };
    }
  }

  /** Pull the ERP catalog (SKUs) → upsert item_cart, paging through all rows. */
  private async pullItems(): Promise<number> {
    const pageSize = 100;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    let processed = 0;
    while (processed < total) {
      const { data, total: t } = await this.erp.list<ErpSku>('skus', { page, pageSize });
      total = t;
      if (data.length === 0) break;
      for (const row of data) await this.upsertItem(row);
      processed += data.length;
      page += 1;
      if (page > 200) break; // safety cap (20k items)
    }
    return processed;
  }

  private async upsertItem(row: ErpSku): Promise<void> {
    const itemNumber = row.sku;
    if (!itemNumber) return;
    let item = await this.items.findOne({ where: { itemNumber } });
    if (!item) item = this.items.create({ itemNumber });
    const label = row.label ?? row.productName ?? row.sku;
    item.sku = row.sku;
    item.name = label;
    item.nameAr = item.nameAr || label; // don't clobber a curated Arabic name
    item.nameEn = label;
    item.barcode = row.barcode || row.sku; // cash-van barcode is required + unique
    item.price = Math.round((Number(row.sellingPrice) || 0) * 1000); // major → fils
    item.isActive = row.isActive ?? true;
    await this.items.save(item);
    await this.upsertIdMap('item', String(row.id), row.sku, item.id);
  }

  private async upsertIdMap(
    entity: string,
    erpId: string,
    erpCode: string | null,
    localId: string,
  ): Promise<void> {
    let m = await this.idmap.findOne({ where: { entity, erpId } });
    if (!m) m = this.idmap.create({ entity, erpId });
    m.erpCode = erpCode;
    m.localId = localId;
    await this.idmap.save(m);
  }

  private async saveCursor(
    entity: string,
    status: string,
    count: number,
    error: string | null,
  ): Promise<void> {
    let c = await this.cursors.findOne({ where: { entity } });
    if (!c) c = this.cursors.create({ entity });
    c.lastRunAt = new Date();
    c.lastStatus = status;
    c.lastCount = count;
    c.lastError = error;
    await this.cursors.save(c);
  }
}
