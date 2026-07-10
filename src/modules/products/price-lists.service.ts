import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { PriceList } from './entities/price-list.entity';
import { PriceListItem } from './entities/price-list-item.entity';

export interface PriceListView {
  id: string;
  code: string;
  name: string;
  origin: string;
  isActive: boolean;
  itemCount: number;
  customerCount: number;
}

export interface PriceListItemView {
  id: string;
  itemId: string;
  itemNumber: string | null;
  productName: string | null;
  barcode: string | null;
  basePrice: number; // fils (catalog)
  unitPrice: number; // fils (this list)
}

@Injectable()
export class PriceListsService {
  constructor(
    @InjectRepository(PriceList) private readonly lists: Repository<PriceList>,
    @InjectRepository(PriceListItem) private readonly items: Repository<PriceListItem>,
    @InjectRepository(ItemCart) private readonly products: Repository<ItemCart>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
  ) {}

  /** All price lists with their item + assigned-customer counts. */
  async list(): Promise<PriceListView[]> {
    const rows = await this.lists.find({ order: { name: 'ASC' } });
    return Promise.all(
      rows.map(async (l) => ({
        id: l.id,
        code: l.code,
        name: l.name,
        origin: l.origin,
        isActive: l.isActive,
        itemCount: await this.items.count({ where: { priceListId: l.id } }),
        customerCount: await this.customers.count({ where: { priceListId: l.id } }),
      })),
    );
  }

  /** One list's items, each with the catalog base price for comparison. */
  async listItems(priceListId: string): Promise<PriceListItemView[]> {
    const list = await this.lists.findOne({ where: { id: priceListId } });
    if (!list) throw new NotFoundException(`Price list ${priceListId} not found`);
    const rows = await this.items.find({ where: { priceListId } });
    return Promise.all(
      rows.map(async (r) => {
        const p = await this.products.findOne({ where: { id: r.itemId } });
        return {
          id: r.id,
          itemId: r.itemId,
          itemNumber: p?.itemNumber ?? null,
          productName: p?.nameAr ?? p?.name ?? null,
          barcode: p?.barcode ?? null,
          basePrice: p?.price ?? 0,
          unitPrice: r.unitPrice,
        };
      }),
    );
  }

  /**
   * All ACTIVE lists with their item prices in one payload — for the mobile app's
   * offline cache. The app resolves a line by the customer's `priceListId`
   * (exposed on the customer record) → this list's `items[itemNumber/barcode]`.
   */
  async full(): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      items: Array<{
        itemId: string;
        itemNumber: string | null;
        barcode: string | null;
        unitPrice: number;
      }>;
    }>
  > {
    const lists = await this.lists.find({ where: { isActive: true }, order: { name: 'ASC' } });
    return Promise.all(
      lists.map(async (l) => {
        const rows = await this.items.find({ where: { priceListId: l.id } });
        const items = await Promise.all(
          rows.map(async (r) => {
            const p = await this.products.findOne({ where: { id: r.itemId } });
            return {
              itemId: r.itemId,
              itemNumber: p?.itemNumber ?? null,
              barcode: p?.barcode ?? null,
              unitPrice: r.unitPrice,
            };
          }),
        );
        return { id: l.id, code: l.code, name: l.name, items };
      }),
    );
  }

  async create(input: { code: string; name: string }): Promise<PriceList> {
    const code = input.code.trim();
    if (!code) throw new BadRequestException('code is required');
    const dup = await this.lists.exist({ where: { code } });
    if (dup) throw new ConflictException(`Price list '${code}' already exists`);
    return this.lists.save(
      this.lists.create({ code, name: input.name.trim() || code, origin: 'local' }),
    );
  }

  async update(id: string, input: { name?: string; isActive?: boolean }): Promise<PriceList> {
    const list = await this.lists.findOne({ where: { id } });
    if (!list) throw new NotFoundException(`Price list ${id} not found`);
    if (input.name !== undefined) list.name = input.name.trim() || list.name;
    if (input.isActive !== undefined) list.isActive = input.isActive;
    return this.lists.save(list);
  }

  /** Delete a list, its item prices, and unassign its customers. */
  async remove(id: string): Promise<{ deleted: boolean }> {
    const list = await this.lists.findOne({ where: { id } });
    if (!list) throw new NotFoundException(`Price list ${id} not found`);
    await this.customers.update({ priceListId: id }, { priceListId: null });
    await this.items.delete({ priceListId: id });
    await this.lists.delete(id);
    return { deleted: true };
  }

  /** Create/update one item's price under a list. `unitPrice` in fils. */
  async setItem(
    priceListId: string,
    input: { itemId: string; unitPrice: number },
  ): Promise<PriceListItem> {
    if (!Number.isInteger(input.unitPrice) || input.unitPrice < 0) {
      throw new BadRequestException('unitPrice must be a non-negative integer (fils)');
    }
    const list = await this.lists.findOne({ where: { id: priceListId } });
    if (!list) throw new NotFoundException(`Price list ${priceListId} not found`);
    const product = await this.products.findOne({ where: { id: input.itemId } });
    if (!product) throw new NotFoundException(`Item ${input.itemId} not found`);
    let row = await this.items.findOne({ where: { priceListId, itemId: input.itemId } });
    if (!row) row = this.items.create({ priceListId, itemId: input.itemId });
    row.unitPrice = input.unitPrice;
    return this.items.save(row);
  }

  async removeItem(priceListId: string, itemId: string): Promise<{ deleted: boolean }> {
    const row = await this.items.findOne({ where: { priceListId, itemId } });
    if (!row) throw new NotFoundException('Price list item not found');
    await this.items.delete(row.id);
    return { deleted: true };
  }

  /** Assign (or clear, when priceListId is null) a customer's price list. */
  async assignCustomer(
    customerId: string,
    priceListId: string | null,
  ): Promise<{ customerId: string; priceListId: string | null }> {
    const cust = await this.customers.findOne({
      where: { id: customerId, deletedAt: IsNull() },
    });
    if (!cust) throw new NotFoundException(`Customer ${customerId} not found`);
    if (priceListId) {
      const list = await this.lists.findOne({ where: { id: priceListId } });
      if (!list) throw new NotFoundException(`Price list ${priceListId} not found`);
    }
    cust.priceListId = priceListId;
    await this.customers.save(cust);
    return { customerId, priceListId };
  }
}
