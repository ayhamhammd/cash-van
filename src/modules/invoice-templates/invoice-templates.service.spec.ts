import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  InvoiceTemplatesService,
  assertLayoutShape,
  toBuiltin,
  versionOf,
} from './invoice-templates.service';
import { BUILTIN_ELEMENT_TYPES, BUILTIN_LAYOUTS, builtinFor } from './builtin-layouts';
import { ARABIC_KIND_NAMES, DOCUMENT_TYPES, type DocumentType } from './dto/invoice-template.dto';

/**
 * The fallback chain, the storeNumber lookup, the "one global default" rule
 * and the built-in layouts, exercised against hand-rolled repository mocks —
 * no Nest context, no database.
 */
const LAYOUT = { version: 1, layout: { width: 210 }, elements: [] };

/** TypeORM's IsNull() operator (a FindOperator) matches a null column. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (typeof v === 'object' && v !== null && '_type' in (v as object)) return row[k] == null;
    return row[k] === v;
  });
}

describe('InvoiceTemplatesService', () => {
  function build(
    rows: Array<Record<string, unknown>> = [],
    warehouses: Array<{ id: string; whNumber: string }> = [],
    caller: { repId?: string | null; reps?: Array<{ id: string; vanId: string | null }> } = {},
  ) {
    const findOne = jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null);
    const find = jest.fn(async () => rows);
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const create = jest.fn((x: unknown) => x);
    const save = jest.fn(async (x: unknown) => ({ id: 'saved', ...(x as object) }));
    const del = jest.fn(async ({ id }: { id: string }) => ({ affected: rows.some((r) => r.id === id) ? 1 : 0 }));
    const repo = { findOne, find, update, create, save, delete: del };
    const whRepo = {
      findOne: jest.fn(async ({ where }: { where: { whNumber: string } }) => warehouses.find((w) => w.whNumber === where.whNumber) ?? null),
    };
    const repRepo = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => (caller.reps ?? []).find((r) => r.id === where.id) ?? null),
    };
    const userCtx = { getRepId: () => caller.repId ?? null };
    return {
      svc: new InvoiceTemplatesService(repo as never, whRepo as never, repRepo as never, userCtx as never),
      repo,
      whRepo,
      repRepo,
    };
  }

  const global = { id: 'g', documentType: 'SALE', branchId: null, isDefault: true, updatedAt: new Date('2026-09-01T00:00:00Z') };
  const pinned = { id: 'p', documentType: 'SALE', branchId: 'wh-1', isDefault: false, updatedAt: new Date('2026-09-05T00:00:00Z') };

  describe('resolve', () => {
    it('resolves the store-pinned template first', async () => {
      const { svc } = build([global, pinned]);
      expect((await svc.resolve('SALE', { branchId: 'wh-1' })).id).toBe('p');
    });

    it('falls back to the global default when the store has none', async () => {
      const { svc } = build([global]);
      expect((await svc.resolve('SALE', { branchId: 'wh-9' })).id).toBe('g');
    });

    it('falls back to the built-in layout when nothing is saved', async () => {
      const { svc } = build([]);
      const t = await svc.resolve('SALE');
      expect(t.id).toBeNull();
      expect(t.documentType).toBe('SALE');
      expect(t.paperSize).toBe('THERMAL_80');
      expect((t.layout as { elements: unknown[] }).elements.length).toBeGreaterThan(0);
    });

    it('looks a storeNumber up by whNumber and uses the warehouse id', async () => {
      const { svc, whRepo } = build([global, pinned], [{ id: 'wh-1', whNumber: 'VAN1' }]);
      expect((await svc.resolve('SALE', { storeNumber: 'VAN1' })).id).toBe('p');
      expect(whRepo.findOne).toHaveBeenCalledWith({ where: { whNumber: 'VAN1' } });
    });

    it('treats an unknown storeNumber as no store and uses the global chain', async () => {
      const { svc } = build([global, pinned], []);
      expect((await svc.resolve('SALE', { storeNumber: 'NOPE' })).id).toBe('g');
    });

    it('prefers branchId over storeNumber and skips the lookup', async () => {
      const { svc, whRepo } = build([global, pinned], [{ id: 'wh-2', whNumber: 'VAN2' }]);
      expect((await svc.resolve('SALE', { branchId: 'wh-1', storeNumber: 'VAN2' })).id).toBe('p');
      expect(whRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('resolveAll', () => {
    it('returns every kind and reports "builtin" when nothing is saved', async () => {
      const { svc } = build([]);
      const res = await svc.resolveAll();
      expect(Object.keys(res.templates).sort()).toEqual([...DOCUMENT_TYPES].sort());
      for (const kind of DOCUMENT_TYPES) {
        expect(res.templates[kind].id).toBeNull();
        expect(res.templates[kind].documentType).toBe(kind);
      }
      expect(res.version).toBe('builtin');
    });

    it('applies pinned → default → builtin per kind and versions on the newest updatedAt', async () => {
      const ret = { id: 'r', documentType: 'RETURN', branchId: null, isDefault: true, updatedAt: new Date('2026-09-07T10:00:00Z') };
      const { svc } = build([global, pinned, ret], [{ id: 'wh-1', whNumber: 'VAN1' }]);
      const res = await svc.resolveAll({ storeNumber: 'VAN1' });
      expect(res.templates.SALE.id).toBe('p');
      expect(res.templates.RETURN.id).toBe('r');
      expect(res.templates.TRANSFER.id).toBeNull();
      expect(res.version).toBe('2026-09-07T10:00:00.000Z');
    });

    it('does not pin another store\'s template', async () => {
      const { svc } = build([global, pinned]);
      const res = await svc.resolveAll({ branchId: 'wh-other' });
      expect(res.templates.SALE.id).toBe('g');
    });

    it('ignores a non-default global row for the chain but counts it for the version', async () => {
      const draft = { id: 'd', documentType: 'SALE', branchId: null, isDefault: false, updatedAt: new Date('2026-09-09T00:00:00Z') };
      const { svc } = build([draft]);
      const res = await svc.resolveAll();
      expect(res.templates.SALE.id).toBeNull();
      expect(res.version).toBe('2026-09-09T00:00:00.000Z');
    });
  });

  describe('versionOf', () => {
    it('is "builtin" with no rows and the newest ISO otherwise', () => {
      expect(versionOf([])).toBe('builtin');
      expect(versionOf([{ updatedAt: new Date('2026-01-01T00:00:00Z') }, { updatedAt: new Date('2026-03-01T00:00:00Z') }])).toBe('2026-03-01T00:00:00.000Z');
    });

    it('accepts ISO strings (a raw query result) and skips unparsable dates', () => {
      expect(versionOf([{ updatedAt: '2026-02-01T00:00:00Z' as unknown as Date }, { updatedAt: 'garbage' as unknown as Date }])).toBe('2026-02-01T00:00:00.000Z');
    });
  });

  describe('built-in layouts', () => {
    it('ships one built-in per voucher kind and nothing else', () => {
      expect(Object.keys(BUILTIN_LAYOUTS).sort()).toEqual([...DOCUMENT_TYPES].sort());
      expect(Object.keys(ARABIC_KIND_NAMES).sort()).toEqual([...DOCUMENT_TYPES].sort());
    });

    it.each(DOCUMENT_TYPES)('%s: a valid 80 mm thermal layout using only the allowed element types', (kind) => {
      const layout = builtinFor(kind);
      expect(() => assertLayoutShape(layout as unknown as Record<string, unknown>)).not.toThrow();
      expect(layout.version).toBe(1);
      expect(layout.layout.width).toBe(80);
      expect(layout.layout.height).toBeNull();
      expect(layout.layout.unit).toBe('mm');
      expect(layout.layout.margins).toEqual({ top: 4, right: 4, bottom: 4, left: 4 });
      expect(layout.elements.length).toBeGreaterThan(0);
      const ids = new Set<string>();
      for (const el of layout.elements) {
        expect(BUILTIN_ELEMENT_TYPES).toContain(el.type);
        expect(['header', 'body', 'footer']).toContain(el.zone);
        expect(el.x + el.width).toBeLessThanOrEqual(72);
        expect(ids.has(el.id)).toBe(false);
        ids.add(el.id);
      }
    });

    it.each(DOCUMENT_TYPES)('%s: fixed elements fit inside their zone and the body holds only flow elements', (kind) => {
      const layout = builtinFor(kind);
      const zoneMin = { header: layout.layout.zones.header.minHeight, footer: layout.layout.zones.footer.minHeight };
      for (const el of layout.elements) {
        const flow = el.type === 'ITEMS_TABLE' || el.type === 'TOTALS_BLOCK';
        if (el.zone === 'body') {
          // A fixed element in the body would be drawn on top of the table.
          expect(flow).toBe(true);
          expect(el.height).toBeNull();
        } else {
          expect(flow).toBe(false);
          expect(el.height).not.toBeNull();
          expect(el.y + (el.height as number)).toBeLessThanOrEqual(zoneMin[el.zone]);
        }
      }
    });

    it('the generic receipt carries the company block, meta lines, items table, totals and payments', () => {
      const layout = builtinFor('SALE');
      const contents = layout.elements.map((e) => String(e.props['content'] ?? ''));
      for (const token of [
        '{{company.nameAr}}', '{{company.taxNumber}}', '{{company.phone1}}', '{{company.addressAr}}',
        '{{invoice.taxExempt}}', '{{invoice.number}}', '{{invoice.kindName}}', '{{invoice.date}}',
        '{{invoice.cashier}}', '{{invoice.customer.name}}', '{{invoice.payments}}',
      ]) {
        expect(contents.some((c) => c.includes(token))).toBe(true);
      }
      const table = layout.elements.find((e) => e.type === 'ITEMS_TABLE')!;
      expect((table.props['columns'] as Array<{ key: string }>).map((c) => c.key)).toEqual(['name', 'qty', 'price', 'taxPct', 'discount', 'total']);
      const totals = layout.elements.find((e) => e.type === 'TOTALS_BLOCK')!;
      const rows = totals.props['rows'] as Array<{ value: string; style?: string }>;
      expect(rows.map((r) => r.value)).toEqual([
        '{{invoice.itemCount}}', '{{invoice.subtotal}}', '{{invoice.discount}}', '{{invoice.taxTotal}}', '{{invoice.total}}', '{{invoice.paid}}',
      ]);
      expect(rows.find((r) => r.value === '{{invoice.total}}')!.style).toBe('bold');
    });

    it('TRANSFER shows from/to stores, a picking-list table and two signature lines', () => {
      const layout = builtinFor('TRANSFER');
      const contents = layout.elements.map((e) => String(e.props['content'] ?? ''));
      expect(contents.some((c) => c.includes('{{invoice.fromStore}}'))).toBe(true);
      expect(contents.some((c) => c.includes('{{invoice.toStore}}'))).toBe(true);
      expect(contents.some((c) => c.includes('المرسل'))).toBe(true);
      expect(contents.some((c) => c.includes('المستلم'))).toBe(true);
      const table = layout.elements.find((e) => e.type === 'ITEMS_TABLE')!;
      expect((table.props['columns'] as Array<{ key: string }>).map((c) => c.key)).toEqual(['name', 'sku', 'unit', 'qty']);
      expect(layout.elements.some((e) => e.type === 'TOTALS_BLOCK')).toBe(false);
    });

    it.each([
      ['PAYMENT_IN', 'استلمنا من'],
      ['PAYMENT_OUT', 'دفعنا إلى'],
    ] as Array<[DocumentType, string]>)('%s names the party line "%s" and prints the amount large', (kind, partyLabel) => {
      const layout = builtinFor(kind);
      const texts = layout.elements.filter((e) => e.type === 'TEXT');
      const party = texts.find((e) => String(e.props['content']).includes(partyLabel))!;
      expect(String(party.props['content'])).toContain('{{invoice.customer.name}}');
      const amount = texts.find((e) => e.props['content'] === '{{invoice.total}}')!;
      expect(amount.props['fontWeight']).toBe('bold');
      expect(amount.props['fontSize'] as number).toBeGreaterThanOrEqual(14);
      const contents = texts.map((e) => String(e.props['content']));
      expect(contents.some((c) => c.includes('{{invoice.paymentType}}'))).toBe(true);
      expect(contents.some((c) => c.includes('{{invoice.reference}}'))).toBe(true);
      expect(contents.some((c) => c.includes('{{invoice.note}}'))).toBe(true);
      expect(contents.some((c) => c.includes('التوقيع'))).toBe(true);
      expect(contents.some((c) => c.includes(ARABIC_KIND_NAMES[kind]))).toBe(true);
      expect(layout.elements.some((e) => e.type === 'ITEMS_TABLE')).toBe(false);
    });

    it('toBuiltin wraps the layout as a template with no row behind it', () => {
      const t = toBuiltin('PURCHASE');
      expect(t).toMatchObject({ id: null, documentType: 'PURCHASE', paperSize: 'THERMAL_80', isDefault: true, branchId: null });
      expect(t.layout).toBe(builtinFor('PURCHASE'));
    });

    it('builtin() returns the same object resolve() falls back to', async () => {
      const { svc } = build([]);
      expect(svc.builtin('IN')).toEqual(await svc.resolve('IN'));
    });
  });

  describe('writes', () => {
    it('unsets the previous global default when creating a new one', async () => {
      const { svc, repo } = build([]);
      await svc.create({ name: 'x', documentType: 'SALE', isDefault: true, layout: LAYOUT });
      expect(repo.update).toHaveBeenCalledWith(
        expect.objectContaining({ documentType: 'SALE', isDefault: true }),
        { isDefault: false },
      );
    });

    it('does not touch the global default when creating a store template', async () => {
      const { svc, repo } = build([]);
      await svc.create({ name: 'x', documentType: 'SALE', isDefault: true, branchId: 'wh-1', layout: LAYOUT });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('rejects a layout with no elements array', async () => {
      const { svc } = build([]);
      await expect(svc.create({ name: 'x', documentType: 'SALE', layout: {} })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.create({ name: 'x', documentType: 'SALE', layout: { elements: [] } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falls back to the calling salesman own van store', async () => {
    const vanPinned = { id: 'v', documentType: 'SALE', branchId: 'wh-van', isDefault: false };
    const { svc } = build([global, vanPinned], [], { repId: 'rep-1', reps: [{ id: 'rep-1', vanId: 'wh-van' }] });
    expect((await svc.resolve('SALE')).id).toBe('v');
  });

  it('uses the global default for a caller with no rep row', async () => {
    const vanPinned = { id: 'v', documentType: 'SALE', branchId: 'wh-van', isDefault: false };
    const { svc } = build([global, vanPinned], [], { repId: null });
    expect((await svc.resolve('SALE')).id).toBe('g');
  });

  it('prefers an explicit store over the caller own van', async () => {
    const vanPinned = { id: 'v', documentType: 'SALE', branchId: 'wh-van', isDefault: false };
    const { svc } = build([global, pinned, vanPinned], [{ id: 'wh-1', whNumber: 'MAIN' }], {
      repId: 'rep-1',
      reps: [{ id: 'rep-1', vanId: 'wh-van' }],
    });
    expect((await svc.resolve('SALE', { storeNumber: 'MAIN' })).id).toBe('p');
  });

  it('resolves every kind against the caller own van', async () => {
    const vanPinned = { id: 'v', documentType: 'TRANSFER', branchId: 'wh-van', isDefault: false };
    const { svc } = build([vanPinned], [], { repId: 'rep-1', reps: [{ id: 'rep-1', vanId: 'wh-van' }] });
    const all = await svc.resolveAll();
    expect(all.templates.TRANSFER.id).toBe('v');
    expect(all.templates.SALE.id).toBeNull();
  });

  it('defaults a new template to the 80 mm thermal the field printers use', async () => {
    const { svc } = build([]);
    const saved = await svc.create({ name: 'x', documentType: 'SALE', layout: LAYOUT });
    expect(saved.paperSize).toBe('THERMAL_80');
  });

  it('404s on a missing delete', async () => {
      const { svc } = build([]);
      await expect(svc.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
