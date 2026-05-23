import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
  ) {}

  async create(dto: CreateUserDto): Promise<User> {
    const exists = await this.usersRepo.exist({
      where: { userNumber: dto.userNumber },
    });
    if (exists) {
      throw new ConflictException(
        `User with userNumber ${dto.userNumber} already exists`,
      );
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = this.usersRepo.create({
      userNumber: dto.userNumber,
      name: dto.name,
      userType: dto.userType ?? 'SALES',
      isActive: dto.isActive ?? true,
      passwordHash,
      canMakeVoucher: dto.canMakeVoucher ?? false,
      canEditVoucher: dto.canEditVoucher ?? false,
      canAddCustomer: dto.canAddCustomer ?? false,
      canEditCustomerCredit: dto.canEditCustomerCredit ?? false,
      canAddItems: dto.canAddItems ?? false,
      canEditExpiry: dto.canEditExpiry ?? false,
    });
    return this.usersRepo.save(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOneOrThrow(id);
    Object.assign(user, dto);
    return this.usersRepo.save(user);
  }

  async changePassword(id: string, newPassword: string): Promise<void> {
    const user = await this.findOneOrThrow(id);
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.usersRepo.save(user);
  }

  async remove(id: string): Promise<void> {
    const res = await this.usersRepo.softDelete(id);
    if (!res.affected) {
      throw new NotFoundException(`User ${id} not found`);
    }
  }

  async findOneOrThrow(id: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async findByUserNumberWithSecret(
    userNumber: string,
  ): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.user_number = :userNumber', { userNumber })
      .getOne();
  }

  async paginate(query: PaginationDto): Promise<PaginatedResult<User>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const search = query.search?.trim();
    const where = search
      ? [{ name: ILike(`%${search}%`) }, { userNumber: ILike(`%${search}%`) }]
      : undefined;

    const [items, total] = await this.usersRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
