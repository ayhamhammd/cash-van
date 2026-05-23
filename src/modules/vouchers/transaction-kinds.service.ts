import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionKind } from './entities/transaction-kind.entity';
import { CreateTransactionKindDto } from './dto/create-transaction-kind.dto';

@Injectable()
export class TransactionKindsService {
  constructor(
    @InjectRepository(TransactionKind)
    private readonly repo: Repository<TransactionKind>,
  ) {}

  async create(dto: CreateTransactionKindDto): Promise<TransactionKind> {
    const exists = await this.repo.exist({ where: { transKind: dto.transKind } });
    if (exists) {
      throw new ConflictException(`Transaction kind ${dto.transKind} exists`);
    }
    return this.repo.save(this.repo.create({ ...dto, sign: dto.sign ?? 0 }));
  }

  list(): Promise<TransactionKind[]> {
    return this.repo.find({ order: { transKind: 'ASC' } });
  }

  async findOneOrThrow(transKind: string): Promise<TransactionKind> {
    const tk = await this.repo.findOne({ where: { transKind } });
    if (!tk) {
      throw new NotFoundException(`Transaction kind ${transKind} not found`);
    }
    return tk;
  }
}
