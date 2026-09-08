/**
 * Real-DB tests for the item photo cache.
 *
 * The photo has broken twice in production, at two different links in the chain,
 * and the fix has to hold at both:
 *
 *  1. The ERP kept photos on a container filesystem with no volume, so a deploy
 *     deleted them. Fixed on the ERP side — but a copy held HERE is what makes it
 *     survive the ERP losing a file again, which is what these tests pin.
 *  2. The URL on the item is built from the ERP's configured base, chosen so the
 *     server-to-server sync works. It is regularly a docker-internal address no
 *     phone can resolve. The handset must therefore never fetch it.
 *
 * A real HTTP server stands in for the ERP so the interesting cases can actually
 * happen: upstream down, upstream 404, upstream replaced, upstream lying about
 * what it is serving. A mock cannot fail in those ways convincingly.
 *
 * Skipped unless DB_NAME points at a database with the schema applied.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DataSource, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemImage } from '../items/entities/item-image.entity';
import { ProductCategory } from '../products/entities/product-category.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { ProductsService } from './products.service';

const HAS_DB = Boolean(process.env.DB_NAME);
const run = HAS_DB ? describe : describe.skip;

const P = 'ZZIMG';

/** Not a real picture — nothing on this side decodes one. Identity is what matters. */
const FULL = Buffer.from('FULL-IMAGE-BYTES-0123456789');
const THUMB = Buffer.from('THUMB');
const REPLACEMENT = Buffer.from('REPLACEMENT-IMAGE-BYTES');

run('item photo cache (real DB)', () => {
  let ds: DataSource;
  let service: ProductsService;
  let images: Repository<ItemImage>;
  let items: Repository<ItemCart>;
  let origin = '';
  let server: Server;

  /** How the stand-in ERP behaves on the next request. Reset per test. */
  let upstream: {
    hits: number;
    status: number;
    body: Buffer;
    contentType: string;
    /** Hang past the client's timeout, standing in for an unreachable host. */
    hang: boolean;
  };

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const purge = () =>
    q(`DELETE FROM item_cart WHERE item_number LIKE $1`, [`${P}%`]); // images cascade

  async function makeItem(n: string, imageUrl: string | null) {
    const [row] = await q(
      `INSERT INTO item_cart (item_number, sku, item_name, name_ar, barcode, price, image_url)
       VALUES ($1,$1,$1,$1,$1,1000,$2) RETURNING id`,
      [n, imageUrl],
    );
    return row.id as string;
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      upstream.hits += 1;
      if (upstream.hang) return; // never answers; the client must give up on its own
      const wantsThumb = (req.url ?? '').includes('thumb=1');
      if (upstream.status !== 200) {
        res.writeHead(upstream.status).end();
        return;
      }
      const body = wantsThumb ? THUMB : upstream.body;
      res.writeHead(200, { 'content-type': upstream.contentType, 'content-length': body.length });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'cashvan',
      password: process.env.DB_PASSWORD ?? 'cashvan',
      database: process.env.DB_NAME as string,
      // The whole glob, as the app itself loads: ItemCart's relations reach far
      // enough that naming a handful of entities leaves the metadata incomplete.
      entities: [__dirname + '/../../**/*.entity.{ts,js}'],
      synchronize: false,
    });
    await ds.initialize();
    items = ds.getRepository(ItemCart);
    images = ds.getRepository(ItemImage);
    service = new ProductsService(
      items,
      ds.getRepository(ItemUnit),
      ds.getRepository(ProductCategory),
      images,
      null as never,
    );
    await purge();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (!ds?.isInitialized) return;
    await purge();
    await ds.destroy();
  });

  beforeEach(async () => {
    upstream = { hits: 0, status: 200, body: FULL, contentType: 'image/webp', hang: false };
    await purge();
  });

  /** An ERP-shaped photo URL — the only shape that also has a thumbnail. */
  const erpUrl = (id = '11111111-2222-3333-4444-555555555555') => `${origin}/api/images/${id}`;

  it('fetches a photo once and serves every later request from its own database', async () => {
    await makeItem(`${P}-A`, erpUrl());

    const first = await service.imageBytes(`${P}-A`);
    expect(first!.buffer.equals(FULL)).toBe(true);
    const afterFirst = upstream.hits;

    const second = await service.imageBytes(`${P}-A`);
    const third = await service.imageBytes(`${P}-A`);
    expect(second!.buffer.equals(FULL)).toBe(true);
    expect(third!.buffer.equals(FULL)).toBe(true);
    // The whole point: the ERP was touched for the first request and never again.
    expect(upstream.hits).toBe(afterFirst);
  });

  it('stores the bytes, so the photo outlives the ERP losing the file', async () => {
    await makeItem(`${P}-B`, erpUrl());
    await service.imageBytes(`${P}-B`);

    // The ERP's copy is gone — the exact production failure this exists for.
    upstream.status = 404;

    const served = await service.imageBytes(`${P}-B`);
    expect(served!.buffer.equals(FULL)).toBe(true);
  });

  it('serves the cached photo when the ERP cannot be reached at all', async () => {
    const id = await makeItem(`${P}-C`, erpUrl());
    await service.imageBytes(`${P}-C`);

    // The office replaced the photo, so the item points somewhere new — and the
    // ERP is unreachable, which on a van install is the normal case for the
    // docker-internal address the URL is built from.
    upstream.hang = true;
    await items.update({ id }, { imageUrl: `${erpUrl('99999999-2222-3333-4444-555555555555')}` });

    const served = await service.imageBytes(`${P}-C`);
    // Last week's picture of the right product beats an empty square.
    expect(served!.buffer.equals(FULL)).toBe(true);
  }, 30_000);

  it('takes the new photo when the office replaces it', async () => {
    const id = await makeItem(`${P}-D`, erpUrl());
    expect((await service.imageBytes(`${P}-D`))!.buffer.equals(FULL)).toBe(true);

    upstream.body = REPLACEMENT;
    await items.update({ id }, { imageUrl: erpUrl('88888888-2222-3333-4444-555555555555') });

    const served = await service.imageBytes(`${P}-D`);
    expect(served!.buffer.equals(REPLACEMENT)).toBe(true);
    // And the replacement replaced the row rather than piling up beside it.
    expect(await images.count({ where: { itemId: id } })).toBe(1);
  });

  it('caches the small square alongside the full photo and serves it on request', async () => {
    await makeItem(`${P}-E`, erpUrl());
    await service.imageBytes(`${P}-E`);

    const thumb = await service.imageBytes(`${P}-E`, { thumb: true });
    expect(thumb!.buffer.equals(THUMB)).toBe(true);
    expect(thumb!.buffer.length).toBeLessThan(FULL.length);
    // Both variants came from the one fetch pair; asking for the thumb later
    // must not send anyone back to the ERP.
    const hits = upstream.hits;
    await service.imageBytes(`${P}-E`, { thumb: true });
    expect(upstream.hits).toBe(hits);
  });

  it('falls back to the full photo when a source has no thumbnail', async () => {
    // A plain URL — a legacy /uploads/ path, say. Only the ERP's image endpoint
    // renders a square, so there is nothing smaller to serve.
    await makeItem(`${P}-F`, `${origin}/uploads/old.jpg`);

    const thumb = await service.imageBytes(`${P}-F`, { thumb: true });
    expect(thumb!.buffer.equals(FULL)).toBe(true);
    const row = await images.findOne({ where: { sourceUrl: `${origin}/uploads/old.jpg` } });
    expect(row!.thumb).toBeNull();
  });

  it('gives different tags to the full photo and its thumbnail', async () => {
    await makeItem(`${P}-G`, erpUrl());
    const full = await service.imageBytes(`${P}-G`);
    const thumb = await service.imageBytes(`${P}-G`, { thumb: true });
    // One tag for both would let a handset show the thumbnail in the viewer.
    expect(full!.etag).not.toBe(thumb!.etag);
  });

  it('refuses to store an error page dressed as a photo', async () => {
    await makeItem(`${P}-H`, erpUrl());
    upstream.contentType = 'text/html';

    expect(await service.imageBytes(`${P}-H`)).toBeNull();
    expect(await images.count()).toBe(0);
  });

  it('drops the cached photo when the item no longer has one', async () => {
    const id = await makeItem(`${P}-I`, erpUrl());
    await service.imageBytes(`${P}-I`);
    expect(await images.count({ where: { itemId: id } })).toBe(1);

    await items.update({ id }, { imageUrl: null });

    // Serving the old bytes here would resurrect a photo somebody removed.
    expect(await service.imageBytes(`${P}-I`)).toBeNull();
    expect(await images.count({ where: { itemId: id } })).toBe(0);
  });

  it('reports nothing for an item with no photo and for one that does not exist', async () => {
    await makeItem(`${P}-J`, null);
    expect(await service.imageBytes(`${P}-J`)).toBeNull();
    expect(await service.imageBytes(`${P}-NOSUCH`)).toBeNull();
    expect(upstream.hits).toBe(0);
  });

  it('records what it stored, so the copy can be accounted for', async () => {
    const id = await makeItem(`${P}-K`, erpUrl());
    await service.imageBytes(`${P}-K`);

    const row = await images.findOneOrFail({ where: { itemId: id } });
    expect(row.byteSize).toBe(FULL.length);
    expect(row.data.equals(FULL)).toBe(true);
    expect(row.mime).toBe('image/webp');
    expect(row.sourceUrl).toBe(erpUrl());
  });

  it('lets the photo go when the item is deleted', async () => {
    const id = await makeItem(`${P}-L`, erpUrl());
    await service.imageBytes(`${P}-L`);

    await q(`DELETE FROM item_cart WHERE id = $1`, [id]);
    // Otherwise the bytes sit in the database for ever with nothing pointing at them.
    expect(await images.count({ where: { itemId: id } })).toBe(0);
  });
});
