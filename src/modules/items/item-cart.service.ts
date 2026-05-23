import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { ItemCart } from './entities/item-cart.entity';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import {
  PaginationDto,
  PaginatedResult,
} from '../../common/dto/pagination.dto';

@Injectable()
export class ItemCartService {
  constructor(
    @InjectRepository(ItemCart)
    private readonly itemsRepo: Repository<ItemCart>,
  ) {}

  async create(dto: CreateItemDto): Promise<ItemCart> {
    const dup = await this.itemsRepo.exist({
      where: [
        { itemNumber: dto.itemNumber },
        { barcode: dto.barcode },
      ],
    });
    if (dup) {
      throw new ConflictException(
        `Item with itemNumber/barcode already exists`,
      );
    }
    return this.itemsRepo.save(this.itemsRepo.create(dto));
  }

  async update(id: string, dto: UpdateItemDto): Promise<ItemCart> {
    const item = await this.findOneOrThrow(id);
    Object.assign(item, dto);
    return this.itemsRepo.save(item);
  }

  async findOneOrThrow(id: string): Promise<ItemCart> {
    const item = await this.itemsRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    return item;
  }

  findByBarcode(barcode: string): Promise<ItemCart | null> {
    return this.itemsRepo.findOne({ where: { barcode } });
  }

  findByItemNumber(itemNumber: string): Promise<ItemCart | null> {
    return this.itemsRepo.findOne({ where: { itemNumber } });
  }

  async paginate(query: PaginationDto): Promise<PaginatedResult<ItemCart>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const search = query.search?.trim();
    const where = search
      ? [
          { name: ILike(`%${search}%`) },
          { itemNumber: ILike(`%${search}%`) },
          { barcode: ILike(`%${search}%`) },
        ]
      : undefined;

    const [items, total] = await this.itemsRepo.findAndCount({
      where,
      order: { name: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async remove(id: string): Promise<void> {
    const res = await this.itemsRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Item ${id} not found`);
    }
  }
}
