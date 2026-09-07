import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { InvoiceTemplate } from './entities/invoice-template.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import {
  CreateInvoiceTemplateDto,
  DOCUMENT_TYPES,
  UpdateInvoiceTemplateDto,
  type DocumentType,
  type PaperSize,
} from './dto/invoice-template.dto';
import { builtinFor, type BuiltinLayout } from './builtin-layouts';

/** What `resolve` returns when nothing is saved: a template with no row behind it. */
export interface BuiltinTemplate {
  id: null;
  name: string;
  documentType: DocumentType;
  paperSize: PaperSize;
  isDefault: true;
  branchId: null;
  layout: BuiltinLayout;
  createdAt: null;
  updatedAt: null;
}

export type ResolvedTemplate = InvoiceTemplate | BuiltinTemplate;

/** Which store is printing: the warehouse id, or its whNumber to look up. */
export interface ResolveScope {
  branchId?: string;
  storeNumber?: string;
}

export interface ResolveAllResult {
  templates: Record<DocumentType, ResolvedTemplate>;
  /** Newest `updatedAt` among saved templates (ISO), or "builtin" when none is saved. */
  version: string;
}

export function toBuiltin(documentType: DocumentType): BuiltinTemplate {
  return {
    id: null,
    name: 'Built-in default',
    documentType,
    paperSize: 'THERMAL_80',
    isDefault: true,
    branchId: null,
    layout: builtinFor(documentType),
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * The designer's JSON is stored as-is, but it has to at least be a layout:
 * an `elements` array and a `layout` page block. Anything else would render
 * as a blank page and crash the designer on load.
 */
export function assertLayoutShape(layout: Record<string, unknown>): void {
  const page = layout['layout'];
  if (!Array.isArray(layout['elements']) || typeof page !== 'object' || page === null) {
    throw new BadRequestException({
      message: 'layout must contain an elements array and a layout page block',
      code: 'invalid_template_layout',
    });
  }
}

@Injectable()
export class InvoiceTemplatesService {
  constructor(
    @InjectRepository(InvoiceTemplate)
    private readonly templates: Repository<InvoiceTemplate>,
    @InjectRepository(Warehouse)
    private readonly warehouses: Repository<Warehouse>,
  ) {}

  list(branchId?: string): Promise<InvoiceTemplate[]> {
    return this.templates.find({
      where: branchId ? { branchId } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<InvoiceTemplate> {
    const t = await this.templates.findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Template ${id} not found`);
    return t;
  }

  /**
   * Fallback chain:
   *   1. template pinned to this store for this documentType
   *   2. global default (branchId null, isDefault true)
   *   3. built-in layout
   * An unknown storeNumber pins nothing, so the chain starts at the global default.
   */
  async resolve(documentType: DocumentType, scope: ResolveScope = {}): Promise<ResolvedTemplate> {
    const branchId = await this.branchIdFor(scope);
    if (branchId) {
      const pinned = await this.templates.findOne({ where: { documentType, branchId } });
      if (pinned) return pinned;
    }
    const def = await this.templates.findOne({
      where: { documentType, isDefault: true, branchId: IsNull() },
    });
    if (def) return def;
    return toBuiltin(documentType);
  }

  /**
   * Every kind at once, for a device to cache. Same chain as `resolve`, run
   * over one read of the table. `version` moves whenever any saved template
   * changes, so a device comparing it knows to refresh.
   */
  async resolveAll(scope: ResolveScope = {}): Promise<ResolveAllResult> {
    const branchId = await this.branchIdFor(scope);
    const rows = await this.templates.find();
    const templates = {} as Record<DocumentType, ResolvedTemplate>;
    for (const kind of DOCUMENT_TYPES) {
      const pinned = branchId ? rows.find((r) => r.documentType === kind && r.branchId === branchId) : undefined;
      const def = rows.find((r) => r.documentType === kind && r.isDefault && r.branchId == null);
      templates[kind] = pinned ?? def ?? toBuiltin(kind);
    }
    return { templates, version: versionOf(rows) };
  }

  builtin(documentType: DocumentType): BuiltinTemplate {
    return toBuiltin(documentType);
  }

  async create(dto: CreateInvoiceTemplateDto): Promise<InvoiceTemplate> {
    assertLayoutShape(dto.layout);
    const branchId = dto.branchId || null;
    if (dto.isDefault && !branchId) {
      await this.clearGlobalDefault(dto.documentType);
    }
    return this.templates.save(
      this.templates.create({
        name: dto.name,
        documentType: dto.documentType,
        paperSize: dto.paperSize ?? 'A4',
        isDefault: Boolean(dto.isDefault),
        branchId,
        layout: dto.layout,
      }),
    );
  }

  async update(id: string, dto: UpdateInvoiceTemplateDto): Promise<InvoiceTemplate> {
    const existing = await this.findOne(id);
    if (dto.layout !== undefined) assertLayoutShape(dto.layout);
    // documentType is immutable: the fallback chain keys on it.
    const nextBranch = dto.branchId === undefined ? existing.branchId : dto.branchId || null;
    const becomesDefault = dto.isDefault === true && !existing.isDefault;
    if (becomesDefault && !nextBranch) {
      await this.clearGlobalDefault(existing.documentType as DocumentType);
    }
    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.paperSize !== undefined) existing.paperSize = dto.paperSize;
    if (dto.isDefault !== undefined) existing.isDefault = Boolean(dto.isDefault);
    if (dto.branchId !== undefined) existing.branchId = nextBranch;
    if (dto.layout !== undefined) existing.layout = dto.layout;
    return this.templates.save(existing);
  }

  async remove(id: string): Promise<void> {
    const res = await this.templates.delete({ id });
    if (!res.affected) throw new NotFoundException(`Template ${id} not found`);
  }

  /** Only one global default per document type. */
  private async clearGlobalDefault(documentType: DocumentType): Promise<void> {
    await this.templates.update(
      { documentType, isDefault: true, branchId: IsNull() },
      { isDefault: false },
    );
  }

  /** `branchId` wins; otherwise a storeNumber is looked up. Unknown store → undefined. */
  private async branchIdFor({ branchId, storeNumber }: ResolveScope): Promise<string | undefined> {
    if (branchId) return branchId;
    if (!storeNumber) return undefined;
    const wh = await this.warehouses.findOne({ where: { whNumber: storeNumber } });
    return wh?.id;
  }
}

/** Newest updatedAt as ISO, or "builtin" when no template is saved. */
export function versionOf(rows: ReadonlyArray<Pick<InvoiceTemplate, 'updatedAt'>>): string {
  let newest: Date | null = null;
  for (const r of rows) {
    const at = r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt);
    if (Number.isNaN(at.getTime())) continue;
    if (!newest || at > newest) newest = at;
  }
  return newest ? newest.toISOString() : 'builtin';
}
