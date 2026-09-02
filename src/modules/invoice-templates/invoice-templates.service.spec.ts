import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvoiceTemplatesService, toBuiltin } from './invoice-templates.service';

/**
 * The fallback chain and the "one global default" rule, exercised against a
 * hand-rolled repository mock — no Nest context, no database.
 */
const LAYOUT = { version: 1, layout: { width: 210 }, elements: [] };

describe('InvoiceTemplatesService', () => {
  function build(rows: Array<Record<string, unknown>> = []) {
    const findOne = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => {
            // TypeORM's IsNull() operator: match a null column.
            if (typeof v === 'object' && v !== null && '_type' in (v as object)) return r[k] == null;
            return r[k] === v;
          }),
        ) ?? null
      );
    });
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const create = jest.fn((x: unknown) => x);
    const save = jest.fn(async (x: unknown) => ({ id: 'saved', ...(x as object) }));
    const del = jest.fn(async ({ id }: { id: string }) => ({ affected: rows.some((r) => r.id === id) ? 1 : 0 }));
    const repo = { findOne, update, create, save, delete: del, find: jest.fn() };
    return { svc: new InvoiceTemplatesService(repo as never), repo };
  }

  it('resolves the branch-pinned template first', async () => {
    const pinned = { id: 'p', documentType: 'SALE_INVOICE', branchId: 'wh-1', isDefault: false };
    const global = { id: 'g', documentType: 'SALE_INVOICE', branchId: null, isDefault: true };
    const { svc } = build([global, pinned]);
    expect((await svc.resolve('SALE_INVOICE', 'wh-1')).id).toBe('p');
  });

  it('falls back to the global default when the branch has none', async () => {
    const global = { id: 'g', documentType: 'SALE_INVOICE', branchId: null, isDefault: true };
    const { svc } = build([global]);
    expect((await svc.resolve('SALE_INVOICE', 'wh-9')).id).toBe('g');
  });

  it('falls back to the built-in layout when nothing is saved', async () => {
    const { svc } = build([]);
    const t = await svc.resolve('SALE_INVOICE');
    expect(t.id).toBeNull();
    expect(t.paperSize).toBe('A4');
    expect((t.layout as { elements: unknown[] }).elements.length).toBeGreaterThan(0);
  });

  it('gives label document types their own built-in paper size', () => {
    expect(toBuiltin('SCALE_LABEL').paperSize).toBe('THERMAL_80');
    expect(toBuiltin('BARCODE_LABEL').paperSize).toBe('A4');
  });

  it('unsets the previous global default when creating a new one', async () => {
    const { svc, repo } = build([]);
    await svc.create({ name: 'x', documentType: 'SALE_INVOICE', isDefault: true, layout: LAYOUT });
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: 'SALE_INVOICE', isDefault: true }),
      { isDefault: false },
    );
  });

  it('does not touch the global default when creating a branch template', async () => {
    const { svc, repo } = build([]);
    await svc.create({ name: 'x', documentType: 'SALE_INVOICE', isDefault: true, branchId: 'wh-1', layout: LAYOUT });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a layout with no elements array', async () => {
    const { svc } = build([]);
    await expect(svc.create({ name: 'x', documentType: 'SALE_INVOICE', layout: {} })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 'x', documentType: 'SALE_INVOICE', layout: { elements: [] } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on a missing delete', async () => {
    const { svc } = build([]);
    await expect(svc.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
