import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, In, IsNull, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemImage } from '../items/entities/item-image.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { ProductCategory } from './entities/product-category.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQuery } from './dto/list-products.query';
import { applyTokenSearch } from '../../common/search/token-search.util';

/** One sellable unit of an item (base + each item_unit), sent to the app. */
export interface ProductUnitView {
  name: string;
  code: string;
  /**
   * The item_units row behind this unit — '' for the base unit, which has none.
   * The app posts it back as the line's itemUnitId; it is the only stable
   * identity a colour has (barcodes are optional and names repeat).
   */
  itemUnitId: string;
  /** Pieces (base units) this unit represents — base = 1. */
  conversionQty: number;
  /** Unit sale price in fils (minor units), like the item price. */
  priceFils: number;
  barcode: string;
  isBase: boolean;
  /** True when this unit is a variant that owns its own stock pool. */
  isStockUnit: boolean;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ItemCart)
    private readonly products: Repository<ItemCart>,
    @InjectRepository(ItemUnit)
    private readonly itemUnits: Repository<ItemUnit>,
    @InjectRepository(ProductCategory)
    private readonly categories: Repository<ProductCategory>,
    @InjectRepository(ItemImage)
    private readonly itemImages: Repository<ItemImage>,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    query: ListProductsQuery,
    allowedItemNumbers?: string[],
  ): Promise<{ items: ItemCart[]; total: number }> {
    const qb = this.products
      .createQueryBuilder('p')
      .where('p.deleted_at IS NULL')
      .orderBy('p.name_ar', 'ASC')
      // Unique tiebreaker: name_ar is NOT unique (many variants share a name), and
      // LIMIT/OFFSET over a non-unique sort lets Postgres order ties differently on
      // each page request, so a tied row near a page boundary is silently SKIPPED —
      // it syncs to no page and vanishes from the app catalogue (the 213/270/312
      // "item has stock but never shows on mobile" bug). The PK makes the total
      // order deterministic so every offset window is exact.
      .addOrderBy('p.id', 'ASC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    // Restrict to the salesman's van-store allowlist when one is supplied. An empty
    // list is NOT passed (see the controller) — empty means "no restriction", so a
    // manager/admin and an unlinked van both see the full catalogue.
    if (allowedItemNumbers && allowedItemNumbers.length) {
      qb.andWhere('p.item_number IN (:...allow)', { allow: allowedItemNumbers });
    }

    if (query.categoryId) qb.andWhere('p.category_id = :cid', { cid: query.categoryId });
    if (query.isActive !== undefined) qb.andWhere('p.is_active = :a', { a: query.isActive });
    applyTokenSearch(qb, query.q, [
      'p.item_number',
      'p.sku',
      'p.name_ar',
      'p.item_name',
      'p.barcode',
    ]);
    const [items, total] = await qb.getManyAndCount();
    await this.attachUnits(items);
    await this.attachCategoryNames(items);
    return { items, total };
  }

  /**
   * Attach a human category name (Arabic) to each item so the app shows real
   * category labels instead of the raw category UUID. One query for the page.
   */
  private async attachCategoryNames(items: ItemCart[]): Promise<void> {
    const ids = [
      ...new Set(items.map((i) => i.categoryId).filter((c): c is string => !!c)),
    ];
    if (ids.length === 0) return;
    const cats = await this.categories.find({ where: { id: In(ids) } });
    const nameById = new Map(cats.map((c) => [c.id, c.nameAr]));
    for (const item of items) {
      (item as ItemCart & { categoryName: string | null }).categoryName =
        item.categoryId ? (nameById.get(item.categoryId) ?? null) : null;
    }
  }

  /**
   * Attach each item's real sellable units (the base unit + its item_units) so
   * the app shows the item's own units instead of a hardcoded list. Loaded in
   * one query for the whole page (no N+1).
   */
  private async attachUnits(items: ItemCart[]): Promise<void> {
    if (items.length === 0) return;
    const ids = items.map((i) => i.id);
    const rows = await this.itemUnits.find({
      where: { itemId: In(ids) },
      relations: { unit: true },
    });
    const byItem = new Map<string, ItemUnit[]>();
    for (const r of rows) {
      const list = byItem.get(r.itemId) ?? [];
      list.push(r);
      byItem.set(r.itemId, list);
    }
    for (const item of items) {
      const base: ProductUnitView = {
        name: item.unit,
        code: item.unitOfMeasure,
        itemUnitId: '',
        conversionQty: 1,
        priceFils: item.price,
        barcode: item.barcode,
        isBase: true,
        isStockUnit: false,
      };
      const larger: ProductUnitView[] = (byItem.get(item.id) ?? [])
        .map((iu) => ({
          name: iu.unit?.nameAr || iu.unit?.code || item.unit,
          code: iu.unit?.code ?? item.unitOfMeasure,
          itemUnitId: iu.id,
          conversionQty: iu.qty > 0 ? iu.qty : 1,
          priceFils: Math.round((Number(iu.salePrice) || 0) * 1000),
          barcode: iu.barcode,
          isBase: false,
          isStockUnit: iu.isStockUnit,
        }))
        .sort((a, b) => a.conversionQty - b.conversionQty);
      // The entity is serialized to JSON as-is; an extra prop rides along.
      (item as ItemCart & { units: ProductUnitView[] }).units = [base, ...larger];
    }
  }

  /**
   * An item's photo, served from this server's own database.
   *
   * The bytes are CACHED HERE, and that is the whole point of this method. Two
   * separate failures put a hole in a van's catalogue, and both end here:
   *
   *  - The ERP used to keep photos on its container's filesystem with no volume
   *    behind it, so a deploy deleted every one of them while the product rows
   *    went on pointing at the gaps. Photos live in its database now, but every
   *    copy already cached here survives even that going wrong again.
   *  - The stored URL is built from the ERP's CONFIGURED base, which is chosen
   *    to make the server-to-server sync work and is routinely an address only
   *    reachable inside the docker network. Fetching it is this server's job,
   *    never the handset's — which is why the proxy exists at all.
   *
   * The old version fetched upstream on EVERY request, which made each photo as
   * available as the ERP happened to be at that second, and no more. Now upstream
   * is touched once per photo: on a miss, or when the office replaces the picture
   * and the item's URL changes with it.
   *
   * A failed fetch falls back to whatever is already cached, stale source and
   * all. A rep in a shop is far better served by last week's picture of a product
   * than by an empty square, and the URL only changes when someone deliberately
   * replaces the photo — so the stale copy is still a picture of the right thing.
   */
  async imageBytes(
    itemNumber: string,
    opts: { thumb?: boolean } = {},
  ): Promise<{ buffer: Buffer; contentType: string; etag: string } | null> {
    const row = await this.products.findOne({
      where: { itemNumber },
      select: { id: true, imageUrl: true },
    });
    if (!row) return null;

    const cached = await this.itemImages.findOne({ where: { itemId: row.id } });
    const source = row.imageUrl?.trim() || null;

    // Fresh: the cached copy was taken from the URL the item carries right now.
    if (cached && source && cached.sourceUrl === source) return this.served(cached, opts.thumb);

    // The item has no photo at all. Anything cached is a leftover from one that
    // was removed, and serving it would resurrect a deleted picture.
    if (!source) {
      if (cached) await this.itemImages.delete({ itemId: row.id });
      return null;
    }

    const fetched = await this.fetchUpstream(source);
    if (!fetched) {
      // Upstream is unreachable or has lost the file. Serve the old copy if there
      // is one — see above — and only give up when there is nothing at all.
      return cached ? this.served(cached, opts.thumb) : null;
    }

    const saved = this.itemImages.create({
      ...(cached ? { id: cached.id } : {}),
      itemId: row.id,
      sourceUrl: source,
      data: fetched.data,
      thumb: fetched.thumb,
      mime: fetched.mime,
      byteSize: fetched.data.length,
      fetchedAt: new Date(),
    });
    // A concurrent request for the same cold photo would otherwise collide on
    // uq_item_images_item. Losing that race is harmless — the winner cached the
    // very same bytes — so the response is served either way.
    await this.itemImages.save(saved).catch(() => undefined);
    return this.served(saved, opts.thumb);
  }

  /** The stored copy as a response: the small square when asked for and present. */
  private served(
    img: ItemImage,
    thumb?: boolean,
  ): { buffer: Buffer; contentType: string; etag: string } {
    const useThumb = Boolean(thumb && img.thumb && img.thumb.length > 0);
    const buffer = useThumb ? (img.thumb as Buffer) : img.data;
    return {
      buffer,
      contentType: img.mime,
      // Identifies these exact bytes: the row, which variant, and which fetch
      // produced it. A replaced photo re-fetches and moves fetchedAt, so a
      // handset holding the old one is told to take the new.
      etag: `"${img.id}-${useThumb ? 't' : 'f'}-${img.fetchedAt.getTime()}"`,
    };
  }

  /**
   * Pull one photo from wherever it is hosted, server-to-server.
   *
   * Bounded on purpose. An unreachable ERP must cost this request a few seconds
   * and no more, because a van app waiting on a picture is a van app that looks
   * broken; and an upstream that answers with something enormous must not be
   * copied into this database row by row.
   */
  private async fetchUpstream(
    url: string,
  ): Promise<{ data: Buffer; thumb: Buffer | null; mime: string } | null> {
    const main = await this.getBytes(url);
    if (!main) return null;
    // The ERP renders a 200px square for every photo it stores. Taking it now
    // costs one more server-to-server call, once, and saves every list on every
    // handset from downloading the full picture to draw a 40dp thumbnail.
    const thumb = this.isErpImageUrl(url) ? await this.getBytes(`${url}?thumb=1`) : null;
    return { data: main.bytes, thumb: thumb?.bytes ?? null, mime: main.mime };
  }

  /** ERP-served photo — `/api/images/<uuid>`, the only source with a thumb variant. */
  private isErpImageUrl(url: string): boolean {
    return /\/api\/images\/[0-9a-f-]{36}$/i.test(url);
  }

  private async getBytes(url: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const MAX_BYTES = 8 * 1024 * 1024;
    const TIMEOUT_MS = 8000;
    const abort = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: abort });
      if (!res.ok) return null;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      // Checked again after reading: content-length is a claim, not a promise.
      if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
      const mime = res.headers.get('content-type')?.split(';')[0]?.trim();
      // A misconfigured upstream answering an HTML error page with 200 must not
      // be stored as though it were a picture.
      if (mime && !mime.startsWith('image/')) return null;
      return { bytes, mime: mime || 'image/jpeg' };
    } catch {
      return null;
    }
  }

  async findOne(id: string): Promise<ItemCart> {
    const p = await this.products.findOne({ where: { id, deletedAt: IsNull() } });
    if (!p) throw new NotFoundException(`Product ${id} not found`);
    // Same units the list sends. Omitting them here meant a client that fetched
    // one product could not tell its variants apart at all.
    await this.attachUnits([p]);
    return p;
  }

  async create(dto: CreateProductDto): Promise<ItemCart> {
    const dup = await this.products.exist({ where: { itemNumber: dto.itemNumber } });
    if (dup) throw new ConflictException(`Product ${dto.itemNumber} already exists`);

    const entity = this.products.create({
      itemNumber: dto.itemNumber,
      sku: dto.sku ?? dto.itemNumber,
      barcode: dto.barcode,
      name: dto.name,
      nameAr: dto.nameAr ?? dto.name,
      nameEn: dto.nameEn ?? null,
      categoryId: dto.categoryId ?? null,
      unit: dto.unit ?? 'carton',
      unitOfMeasure: dto.unitOfMeasure ?? 'PCE',
      price: dto.price,
      cost: dto.cost ?? null,
      erpCategoryId: dto.erpCategoryId ?? null,
      erpTaxRateId: dto.erpTaxRateId ?? null,
      imageUrl: dto.imageUrl ?? null,
      isActive: dto.isActive ?? true,
      reorderQty: dto.reorderQty ?? 0,
      taxType: dto.taxType ?? 'TAXABLE',
      taxCategory: dto.taxCategory ?? 'S',
      taxRate: (dto.taxRate ?? 0.16).toString(),
      taxPercentage: ((dto.taxRate ?? 0.16) * 100).toFixed(2),
    });
    const saved = await this.products.save(entity);
    // Mirror to the ERP (ErpSyncService listener; no-op when ERP off / defaults unset).
    this.events.emit('erp.item.created', {
      itemNumber: saved.itemNumber,
      name: saved.name ?? saved.nameAr ?? saved.itemNumber,
      priceFils: saved.price ?? 0,
      costFils: saved.cost ?? 0,
      erpCategoryId: saved.erpCategoryId ?? null,
      erpTaxRateId: saved.erpTaxRateId ?? null,
    });
    return saved;
  }

  async update(id: string, dto: UpdateProductDto): Promise<ItemCart> {
    const product = await this.findOne(id);
    Object.assign(product, {
      ...dto,
      taxRate: dto.taxRate !== undefined ? dto.taxRate.toString() : product.taxRate,
      taxPercentage:
        dto.taxRate !== undefined ? (dto.taxRate * 100).toFixed(2) : product.taxPercentage,
    });
    return this.products.save(product);
  }

  async softDelete(id: string): Promise<void> {
    const res = await this.products.softDelete({ id });
    if (!res.affected) throw new NotFoundException(`Product ${id} not found`);
  }
}
