import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { InvoiceTemplate } from './entities/invoice-template.entity';
import {
  CreateInvoiceTemplateDto,
  UpdateInvoiceTemplateDto,
  type DocumentType,
  type PaperSize,
} from './dto/invoice-template.dto';
import {
  BUILTIN_BARCODE_LABEL,
  BUILTIN_INVOICE,
  BUILTIN_SCALE_LABEL,
} from './builtin-layouts';

const SPECIAL_LABEL_LAYOUTS: Partial<Record<DocumentType, Record<string, unknown>>> = {
  SCALE_LABEL: BUILTIN_SCALE_LABEL,
  BARCODE_LABEL: BUILTIN_BARCODE_LABEL,
};
const SPECIAL_LABEL_PAPER: Partial<Record<DocumentType, PaperSize>> = {
  SCALE_LABEL: 'THERMAL_80',
  BARCODE_LABEL: 'A4',
};

/** What `resolve` returns when nothing is saved: a template with no row behind it. */
export interface BuiltinTemplate {
  id: null;
  name: string;
  documentType: DocumentType;
  paperSize: PaperSize;
  isDefault: true;
  branchId: null;
  layout: Record<string, unknown>;
  createdAt: null;
  updatedAt: null;
}

export function toBuiltin(documentType: DocumentType, paperSize: PaperSize = 'A4'): BuiltinTemplate {
  return {
    id: null,
    name: 'Built-in Default',
    documentType,
    paperSize: SPECIAL_LABEL_PAPER[documentType] ?? paperSize,
    isDefault: true,
    branchId: null,
    layout: SPECIAL_LABEL_LAYOUTS[documentType] ?? BUILTIN_INVOICE,
    createdAt: null,
    updatedAt: null,
  };
}

@Injectable()
export class InvoiceTemplatesService {
  constructor(
    @InjectRepository(InvoiceTemplate)
    private readonly templates: Repository<InvoiceTemplate>,
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
   *   1. branch-specific template for this documentType
   *   2. global default (branchId null, isDefault true)
   *   3. built-in layout
   */
  async resolve(documentType: DocumentType, branchId?: string): Promise<InvoiceTemplate | BuiltinTemplate> {
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

  async create(dto: CreateInvoiceTemplateDto): Promise<InvoiceTemplate> {
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
}
