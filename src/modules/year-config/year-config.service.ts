import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { YearConfig } from './entities/year-config.entity';
import { CreateYearConfigDto } from './dto/create-year-config.dto';
import { UpdateYearConfigDto } from './dto/update-year-config.dto';

@Injectable()
export class YearConfigService {
  constructor(
    @InjectRepository(YearConfig)
    private readonly repo: Repository<YearConfig>,
  ) {}

  async create(dto: CreateYearConfigDto): Promise<YearConfig> {
    const exists = await this.repo.exist({
      where: { year: dto.year, accName: dto.accName },
    });
    if (exists) {
      throw new ConflictException(
        `Year config ${dto.year}/${dto.accName} already exists`,
      );
    }
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: UpdateYearConfigDto): Promise<YearConfig> {
    const row = await this.findOneOrThrow(id);
    Object.assign(row, dto);
    return this.repo.save(row);
  }

  async findOneOrThrow(id: string): Promise<YearConfig> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Year config ${id} not found`);
    }
    return row;
  }

  listByYear(year: number): Promise<YearConfig[]> {
    return this.repo.find({ where: { year }, order: { accName: 'ASC' } });
  }

  list(): Promise<YearConfig[]> {
    return this.repo.find({ order: { year: 'DESC', accName: 'ASC' } });
  }

  async remove(id: string): Promise<void> {
    const res = await this.repo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`Year config ${id} not found`);
    }
  }
}
