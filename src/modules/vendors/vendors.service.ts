import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { Vendor } from './entities/vendor.entity';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import {
  PaginationDto,
  PaginatedResult,
} from '../../common/dto/pagination.dto';

@Injectable()
export class VendorsService {
  constructor(
    @InjectRepository(Vendor) private readonly vendorsRepo: Repository<Vendor>,
  ) {}

  async create(dto: CreateVendorDto): Promise<Vendor> {
    const exists = await this.vendorsRepo.exist({
      where: { vendorNumber: dto.vendorNumber },
    });
    if (exists) {
      throw new ConflictException(`Vendor ${dto.vendorNumber} already exists`);
    }
    return this.vendorsRepo.save(this.vendorsRepo.create(dto));
  }

  async update(id: string, dto: UpdateVendorDto): Promise<Vendor> {
    const vendor = await this.findOneOrThrow(id);
    Object.assign(vendor, dto);
    return this.vendorsRepo.save(vendor);
  }

  async findOneOrThrow(id: string): Promise<Vendor> {
    const v = await this.vendorsRepo.findOne({ where: { id } });
    if (!v) {
      throw new NotFoundException(`Vendor ${id} not found`);
    }
    return v;
  }

  async findByNumber(vendorNumber: string): Promise<Vendor | null> {
    return this.vendorsRepo.findOne({ where: { vendorNumber } });
  }

  async paginate(query: PaginationDto): Promise<PaginatedResult<Vendor>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const search = query.search?.trim();
    const where = search
      ? [
          { vendorName: ILike(`%${search}%`) },
          { vendorNumber: ILike(`%${search}%`) },
        ]
      : undefined;

    const [items, total] = await this.vendorsRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async remove(id: string): Promise<void> {
    const res = await this.vendorsRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Vendor ${id} not found`);
    }
  }
}
