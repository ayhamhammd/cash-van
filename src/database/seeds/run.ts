import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import type {
  DeepPartial,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import dataSource from '../data-source';
import { User } from '../../modules/users/entities/user.entity';
import { TransactionKind } from '../../modules/vouchers/entities/transaction-kind.entity';
import { Warehouse } from '../../modules/warehouses/entities/warehouse.entity';
import { Unit } from '../../modules/units/entities/unit.entity';
import { ProductCategory } from '../../modules/products/entities/product-category.entity';
import { ItemCart } from '../../modules/items/entities/item-cart.entity';
import { Region } from '../../modules/regions/entities/region.entity';
import { Rep } from '../../modules/reps/entities/rep.entity';
import { Customer } from '../../modules/customers/entities/customer.entity';
import { VanStock } from '../../modules/products/entities/van-stock.entity';
import { Offer } from '../../modules/offers/entities/offer.entity';

/**
 * Demo seed: "مشروبات الأردن" — a Jordan drinks distribution company.
 * Idempotent: every row is upserted on a natural key, so re-running is safe.
 */
async function seed(): Promise<void> {
  await dataSource.initialize();
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  /** Find-or-create on a natural key. */
  async function upsert<T extends ObjectLiteral>(
    repo: Repository<T>,
    where: FindOptionsWhere<NoInfer<T>>,
    data: DeepPartial<NoInfer<T>>,
  ): Promise<T> {
    const found = await repo.findOne({ where });
    if (found) return found;
    return repo.save(repo.create(data));
  }

  try {
    const m = qr.manager;

    // ── transaction kinds ────────────────────────────────────────────────
    const kindsRepo = m.getRepository(TransactionKind);
    const kinds: Array<Partial<TransactionKind>> = [
      { transKind: 'SALE', transName: 'بيع', sign: -1 }, // van out
      { transKind: 'RETURN', transName: 'مرتجع', sign: 1 }, // van in
      { transKind: 'ORDER', transName: 'طلبية', sign: 0 }, // reserve until fulfilled
      { transKind: 'TRANSFER_IN', transName: 'تحميل المركبة', sign: 1 }, // van in
      { transKind: 'TRANSFER_OUT', transName: 'تنزيل المركبة', sign: -1 }, // van out
      { transKind: 'TRANSFER', transName: 'تحويل بين المخازن', sign: 0 }, // stock → stock (uses from/to store)
      { transKind: 'IN', transName: 'إدخال للمخزن', sign: 1 }, // stock in (to_store)
      { transKind: 'OUT', transName: 'إخراج من المخزن', sign: -1 }, // stock out (from_store)
      { transKind: 'PURCHASE', transName: 'شراء', sign: 1 }, // warehouse in
      { transKind: 'ADJUSTMENT', transName: 'تسوية', sign: 0 },
      { transKind: 'PAYMENT_IN', transName: 'سند قبض', sign: 0 },
      { transKind: 'PAYMENT_OUT', transName: 'سند صرف', sign: 0 },
    ];
    for (const k of kinds) {
      await upsert(kindsRepo, { transKind: k.transKind }, k);
    }

    // ── admin user ───────────────────────────────────────────────────────
    const usersRepo = m.getRepository(User);
    const adminHash = await bcrypt.hash('admin1234', 12);
    await upsert(
      usersRepo,
      { userNumber: 'admin' },
      {
        userNumber: 'admin',
        name: 'Default Admin',
        nameAr: 'المدير',
        nameEn: 'Default Admin',
        role: 'admin',
        passwordHash: adminHash,
        userType: 'ADMIN',
        isActive: true,
        canMakeVoucher: true,
        canEditVoucher: true,
        canAddCustomer: true,
        canEditCustomerCredit: true,
        canAddItems: true,
        canEditExpiry: true,
      },
    );

    // ── warehouses: main + 3 vans ────────────────────────────────────────
    const whRepo = m.getRepository(Warehouse);
    await upsert(
      whRepo,
      { whNumber: 'MAIN' },
      { whNumber: 'MAIN', whName: 'المستودع الرئيسي' },
    );
    const vans: Record<string, Warehouse> = {};
    for (const v of [
      { whNumber: 'VAN-01', whName: 'مركبة 1' },
      { whNumber: 'VAN-02', whName: 'مركبة 2' },
      { whNumber: 'VAN-03', whName: 'مركبة 3' },
    ]) {
      vans[v.whNumber] = await upsert(whRepo, { whNumber: v.whNumber }, v);
    }

    // ── units ────────────────────────────────────────────────────────────
    const unitRepo = m.getRepository(Unit);
    const units = [
      { code: 'PCE', nameAr: 'حبة', nameEn: 'Piece', baseQty: 1 },
      { code: 'PK6', nameAr: 'باكيت 6', nameEn: '6-pack', baseQty: 6 },
      { code: 'PK12', nameAr: 'باكيت 12', nameEn: '12-pack', baseQty: 12 },
      { code: 'CTN24', nameAr: 'كرتونة 24', nameEn: 'Carton 24', baseQty: 24 },
    ];
    for (const u of units) await upsert(unitRepo, { code: u.code }, u);

    // ── product categories ───────────────────────────────────────────────
    const catRepo = m.getRepository(ProductCategory);
    const catDefs = [
      { key: 'soft', nameAr: 'مشروبات غازية', nameEn: 'Soft Drinks', sortOrder: 1 },
      { key: 'juice', nameAr: 'عصائر', nameEn: 'Juices', sortOrder: 2 },
      { key: 'water', nameAr: 'مياه', nameEn: 'Water', sortOrder: 3 },
      { key: 'energy', nameAr: 'مشروبات طاقة', nameEn: 'Energy Drinks', sortOrder: 4 },
      { key: 'hot', nameAr: 'شاي وقهوة', nameEn: 'Tea & Coffee', sortOrder: 5 },
    ];
    const catId: Record<string, string> = {};
    for (const c of catDefs) {
      const row = await upsert(
        catRepo,
        { nameEn: c.nameEn },
        { nameAr: c.nameAr, nameEn: c.nameEn, sortOrder: c.sortOrder },
      );
      catId[c.key] = row.id;
    }

    // ── products (drinks) — price in fils (1000 fils = 1 JOD) ─────────────
    const itemRepo = m.getRepository(ItemCart);
    const drinks = [
      { sku: 'COLA-330', nameAr: 'كوكا كولا 330مل', nameEn: 'Coca-Cola 330ml', cat: 'soft', price: 450, cost: 300, reorder: 48 },
      { sku: 'PEPSI-330', nameAr: 'بيبسي 330مل', nameEn: 'Pepsi 330ml', cat: 'soft', price: 450, cost: 300, reorder: 48 },
      { sku: 'SPRITE-330', nameAr: 'سبرايت 330مل', nameEn: 'Sprite 330ml', cat: 'soft', price: 450, cost: 300, reorder: 36 },
      { sku: 'COLA-1L', nameAr: 'كوكا كولا 1 لتر', nameEn: 'Coca-Cola 1L', cat: 'soft', price: 900, cost: 650, reorder: 24 },
      { sku: 'OJ-1L', nameAr: 'عصير برتقال 1 لتر', nameEn: 'Orange Juice 1L', cat: 'juice', price: 1200, cost: 850, reorder: 24 },
      { sku: 'AJ-1L', nameAr: 'عصير تفاح 1 لتر', nameEn: 'Apple Juice 1L', cat: 'juice', price: 1200, cost: 850, reorder: 24 },
      { sku: 'MANGO-250', nameAr: 'عصير مانجو 250مل', nameEn: 'Mango Nectar 250ml', cat: 'juice', price: 500, cost: 320, reorder: 36 },
      { sku: 'WATER-330', nameAr: 'مياه 330مل', nameEn: 'Water 330ml', cat: 'water', price: 150, cost: 80, reorder: 96 },
      { sku: 'WATER-600', nameAr: 'مياه 600مل', nameEn: 'Water 600ml', cat: 'water', price: 250, cost: 130, reorder: 72 },
      { sku: 'WATER-1.5L', nameAr: 'مياه 1.5 لتر', nameEn: 'Water 1.5L', cat: 'water', price: 350, cost: 200, reorder: 48 },
      { sku: 'ENERGY-250', nameAr: 'مشروب طاقة 250مل', nameEn: 'Energy Drink 250ml', cat: 'energy', price: 1000, cost: 700, reorder: 36 },
      { sku: 'ICETEA-330', nameAr: 'شاي مثلج ليمون 330مل', nameEn: 'Iced Tea Lemon 330ml', cat: 'hot', price: 500, cost: 320, reorder: 36 },
      { sku: 'COFFEE-240', nameAr: 'قهوة معلبة 240مل', nameEn: 'Canned Coffee 240ml', cat: 'hot', price: 750, cost: 500, reorder: 24 },
      { sku: 'AYRAN-250', nameAr: 'لبن عيران 250مل', nameEn: 'Ayran 250ml', cat: 'juice', price: 400, cost: 250, reorder: 36 },
    ];
    const productId: Record<string, string> = {};
    for (let i = 0; i < drinks.length; i++) {
      const d = drinks[i];
      // Unique EAN-13-style barcode per item (628 prefix + zero-padded sequence).
      const barcode = `628${String(i + 1).padStart(10, '0')}`;
      const row = await upsert(
        itemRepo,
        { itemNumber: d.sku },
        {
          itemNumber: d.sku,
          sku: d.sku,
          barcode,
          name: d.nameEn,
          nameAr: d.nameAr,
          nameEn: d.nameEn,
          categoryId: catId[d.cat],
          unit: 'carton',
          unitOfMeasure: 'PCE',
          price: d.price,
          cost: d.cost,
          reorderQty: d.reorder,
          isActive: true,
          taxType: 'TAXABLE',
          taxCategory: 'S',
          taxRate: '0.16',
          taxPercentage: '16',
        },
      );
      productId[d.sku] = row.id;
    }

    // ── regions (Amman + nearby) ─────────────────────────────────────────
    const regionRepo = m.getRepository(Region);
    const regionDefs = [
      { code: 'AMM-C', nameAr: 'وسط عمان', nameEn: 'Central Amman' },
      { code: 'AMM-W', nameAr: 'غرب عمان', nameEn: 'West Amman' },
      { code: 'AMM-E', nameAr: 'شرق عمان', nameEn: 'East Amman' },
      { code: 'ZAR', nameAr: 'الزرقاء', nameEn: 'Zarqa' },
      { code: 'IRB', nameAr: 'إربد', nameEn: 'Irbid' },
    ];
    const regionId: Record<string, string> = {};
    for (const r of regionDefs) {
      const row = await upsert(regionRepo, { code: r.code }, { ...r, isActive: true });
      regionId[r.code] = row.id;
    }

    // ── sales users + reps (salesmen) ────────────────────────────────────
    const salesHash = await bcrypt.hash('sales1234', 12);
    const repDefs = [
      { userNumber: 'U-101', code: 'S-101', nameAr: 'سامر خالد', nameEn: 'Samer Khaled', phone: '0790000101', region: 'AMM-C', van: 'VAN-01', quota: 300000 },
      { userNumber: 'U-102', code: 'S-102', nameAr: 'ليث عمر', nameEn: 'Laith Omar', phone: '0790000102', region: 'AMM-W', van: 'VAN-02', quota: 300000 },
      { userNumber: 'U-103', code: 'S-103', nameAr: 'محمد ناصر', nameEn: 'Mohammad Nasser', phone: '0790000103', region: 'AMM-E', van: 'VAN-03', quota: 250000 },
    ];
    const repRepo = m.getRepository(Rep);
    const repId: Record<string, string> = {};
    for (const r of repDefs) {
      const u = await upsert(
        usersRepo,
        { userNumber: r.userNumber },
        {
          userNumber: r.userNumber,
          name: r.nameEn,
          nameAr: r.nameAr,
          nameEn: r.nameEn,
          role: 'viewer',
          userType: 'SALES',
          passwordHash: salesHash,
          isActive: true,
          canMakeVoucher: true,
          canEditVoucher: false,
          canAddCustomer: true,
          canEditCustomerCredit: false,
          canAddItems: false,
          canEditExpiry: false,
        },
      );
      const rep = await upsert(
        repRepo,
        { code: r.code },
        {
          code: r.code,
          nameAr: r.nameAr,
          nameEn: r.nameEn,
          phone: r.phone,
          userId: u.id,
          regionId: regionId[r.region],
          vanId: vans[r.van].id,
          isActive: true,
          dailyQuotaFils: r.quota,
        },
      );
      repId[r.code] = rep.id;
    }

    // ── customers (shops/markets) ────────────────────────────────────────
    const custRepo = m.getRepository(Customer);
    const custDefs = [
      { num: 'C-1001', ar: 'سوبرماركت السلام', en: 'Al-Salam Supermarket', city: 'عمان', region: 'AMM-C', rep: 'S-101', type: 'CREDIT', credit: '800.00', lat: '31.951600', lng: '35.923100' },
      { num: 'C-1002', ar: 'بقالة النور', en: 'Al-Noor Grocery', city: 'عمان', region: 'AMM-C', rep: 'S-101', type: 'CASH', credit: '0.00', lat: '31.957900', lng: '35.945200' },
      { num: 'C-1003', ar: 'ماركت الرابية', en: 'Rabieh Market', city: 'عمان', region: 'AMM-W', rep: 'S-102', type: 'CREDIT', credit: '1200.00', lat: '31.987400', lng: '35.872500' },
      { num: 'C-1004', ar: 'سوبرماركت الصويفية', en: 'Sweifieh Supermarket', city: 'عمان', region: 'AMM-W', rep: 'S-102', type: 'WHOLESALE', credit: '2500.00', lat: '31.952200', lng: '35.860800' },
      { num: 'C-1005', ar: 'بقالة الأمير', en: 'Al-Ameer Grocery', city: 'عمان', region: 'AMM-E', rep: 'S-103', type: 'CASH', credit: '0.00', lat: '31.967300', lng: '35.949900' },
      { num: 'C-1006', ar: 'ماركت طارق', en: 'Tareq Market', city: 'عمان', region: 'AMM-E', rep: 'S-103', type: 'CREDIT', credit: '600.00', lat: '32.012100', lng: '35.962400' },
      { num: 'C-1007', ar: 'سوبرماركت الزرقاء', en: 'Zarqa Supermarket', city: 'الزرقاء', region: 'ZAR', rep: 'S-103', type: 'CREDIT', credit: '1500.00', lat: '32.072500', lng: '36.088800' },
      { num: 'C-1008', ar: 'بقالة المدينة', en: 'Al-Madina Grocery', city: 'الزرقاء', region: 'ZAR', rep: 'S-103', type: 'CASH', credit: '0.00', lat: '32.066000', lng: '36.100200' },
      { num: 'C-1009', ar: 'ماركت إربد المركزي', en: 'Irbid Central Market', city: 'إربد', region: 'IRB', rep: 'S-102', type: 'WHOLESALE', credit: '3000.00', lat: '32.553700', lng: '35.851100' },
      { num: 'C-1010', ar: 'بقالة الياسمين', en: 'Yasmin Grocery', city: 'عمان', region: 'AMM-C', rep: 'S-101', type: 'RETAIL', credit: '300.00', lat: '31.945800', lng: '35.931900' },
      { num: 'C-1011', ar: 'سوبرماركت الجاردنز', en: 'Gardens Supermarket', city: 'عمان', region: 'AMM-W', rep: 'S-102', type: 'CREDIT', credit: '1000.00', lat: '31.984500', lng: '35.886700' },
      { num: 'C-1012', ar: 'بقالة الهاشمي', en: 'Al-Hashemi Grocery', city: 'عمان', region: 'AMM-E', rep: 'S-103', type: 'CASH', credit: '0.00', lat: '31.951900', lng: '35.961200' },
    ];
    for (const c of custDefs) {
      await upsert(
        custRepo,
        { customerNumber: c.num },
        {
          customerNumber: c.num,
          customerName: c.en,
          nameAr: c.ar,
          nameEn: c.en,
          city: c.city,
          addressAr: `${c.city} - ${c.ar}`,
          regionId: regionId[c.region],
          repId: repId[c.rep],
          customerType: c.type as Customer['customerType'],
          creditLimit: c.credit,
          paymentTerms: c.type === 'CASH' ? 0 : 30,
          latitude: c.lat,
          longitude: c.lng,
          isActive: true,
        },
      );
    }

    // ── van stock (load each van) ────────────────────────────────────────
    const vsRepo = m.getRepository(VanStock);
    const load: Record<string, Array<{ sku: string; qty: number }>> = {
      'S-101': [
        { sku: 'COLA-330', qty: 120 }, { sku: 'PEPSI-330', qty: 96 },
        { sku: 'WATER-600', qty: 200 }, { sku: 'OJ-1L', qty: 30 },
        { sku: 'ENERGY-250', qty: 24 }, { sku: 'ICETEA-330', qty: 18 },
      ],
      'S-102': [
        { sku: 'COLA-1L', qty: 60 }, { sku: 'SPRITE-330', qty: 80 },
        { sku: 'WATER-1.5L', qty: 100 }, { sku: 'AJ-1L', qty: 24 },
        { sku: 'MANGO-250', qty: 40 }, { sku: 'COFFEE-240', qty: 12 },
      ],
      'S-103': [
        { sku: 'WATER-330', qty: 240 }, { sku: 'COLA-330', qty: 60 },
        { sku: 'AYRAN-250', qty: 30 }, { sku: 'ENERGY-250', qty: 20 },
        { sku: 'PEPSI-330', qty: 12 }, { sku: 'OJ-1L', qty: 8 },
      ],
    };
    for (const [repCode, lines] of Object.entries(load)) {
      for (const ln of lines) {
        await upsert(
          vsRepo,
          { repId: repId[repCode], productId: productId[ln.sku] },
          {
            repId: repId[repCode],
            productId: productId[ln.sku],
            quantity: ln.qty,
            loadedAt: new Date(),
          },
        );
      }
    }

    // ── demo offers (payment-method, percentage per line) ─────────────────
    // Money is fils. basePercent/maxPercent are 0–100. Legality is enforced by
    // OffersService.validateConfig (mirrored here). Upserted by name.
    const offerRepo = m.getRepository(Offer);
    const offerDefs: Array<Partial<Offer>> = [
      {
        name: 'دفع نقدي — خصم 5%',
        description: 'خصم 5% على كل صنف عند الدفع نقداً لفواتير 10 دنانير فأكثر',
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CASH', minOrderTotal: 10000 },
        reward: { kind: 'LINE_PERCENT_DISCOUNT', basePercent: 5, mode: 'STATIC' },
        eligibility: { customerScope: 'ALL' },
        priority: 10,
        stackable: false,
        isActive: true,
      },
      {
        name: 'دفع آجل — خصم متصاعد',
        description: 'خصم 10% يتصاعد مع الكمية عند الدفع الآجل (×0.5 لكل 6 أصناف، حتى 25%)',
        type: 'PAYMENT_METHOD_DISCOUNT',
        trigger: { paymentCondition: 'CREDIT', minItemCount: 6 },
        reward: {
          kind: 'LINE_PERCENT_DISCOUNT',
          basePercent: 10,
          mode: 'DYNAMIC',
          multiplier: 0.5,
          itemsPerStep: 6,
          maxPercent: 25,
        },
        eligibility: { customerScope: 'ALL' },
        priority: 9,
        stackable: false,
        isActive: true,
      },
      {
        name: 'اشترِ كولا — هدية بالاختيار',
        description: 'اشترِ 10 كولا = هدية، 20 = هديتان (تختار من مياه/مانجو)',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['COLA-330'] },
        reward: {
          kind: 'GIFT',
          giftItems: ['WATER-330', 'MANGO-250'],
          tiers: [
            { minQty: 10, freeQty: 1 },
            { minQty: 20, freeQty: 2 },
          ],
        },
        eligibility: { customerScope: 'ALL' },
        priority: 8,
        stackable: false,
        isActive: true,
      },
      {
        name: 'خصم كمية بيبسي — 10%',
        description: 'اشترِ 12 بيبسي أو أكثر = خصم 10% على البيبسي',
        type: 'ITEM_QTY_REWARD',
        trigger: { itemNumbers: ['PEPSI-330'] },
        reward: {
          kind: 'ITEM_PERCENT_DISCOUNT',
          minQty: 12,
          basePercent: 10,
          mode: 'STATIC',
        },
        eligibility: { customerScope: 'ALL' },
        priority: 7,
        stackable: false,
        isActive: true,
      },
    ];
    for (const o of offerDefs) {
      await upsert(offerRepo, { name: o.name }, o);
    }

    await qr.commitTransaction();
    // eslint-disable-next-line no-console
    console.log(
      `Seed completed: ${drinks.length} products, ${repDefs.length} reps, ${custDefs.length} customers, ${regionDefs.length} regions, ${offerDefs.length} offers.`,
    );
  } catch (err) {
    await qr.rollbackTransaction();
    // eslint-disable-next-line no-console
    console.error('Seed failed', err);
    process.exitCode = 1;
  } finally {
    await qr.release();
    await dataSource.destroy();
  }
}

seed();
