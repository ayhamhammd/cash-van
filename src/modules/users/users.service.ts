import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { User } from './entities/user.entity';
import { RepScopeService } from './rep-scope.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly repScope: RepScopeService,
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
      role: dto.role ?? 'viewer',
      nameAr: dto.nameAr ?? null,
      nameEn: dto.nameEn ?? null,
      email: dto.email ?? null,
      permissions: dto.permissions ?? [],
      isActive: dto.isActive ?? true,
      passwordHash,
      canMakeVoucher: dto.canMakeVoucher ?? false,
      canEditVoucher: dto.canEditVoucher ?? false,
      canAddCustomer: dto.canAddCustomer ?? false,
      canCreateCustomerDirect: dto.canCreateCustomerDirect ?? false,
      canPrintLineDiscount: dto.canPrintLineDiscount ?? false,
      canRequestStock: dto.canRequestStock ?? false,
      canApproveStockRequest: dto.canApproveStockRequest ?? false,
      canFindCustomers: dto.canFindCustomers ?? false,
      canEditCustomerCredit: dto.canEditCustomerCredit ?? false,
      canAddItems: dto.canAddItems ?? false,
      canEditExpiry: dto.canEditExpiry ?? false,
      repScopeMode: dto.repScopeMode ?? 'all',
    });
    const saved = await this.usersRepo.save(user);
    // After the insert: the join rows need the user id, which only exists now.
    if (dto.repIds?.length) await this.repScope.setScope(saved.id, dto.repIds);
    return saved;
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOneOrThrow(id);
    // repIds is a separate TABLE, not a column. Object.assign would drop it onto
    // the entity where it means nothing, and the assignment would silently not save.
    const { repIds, ...columns } = dto;
    Object.assign(user, columns);
    const saved = await this.usersRepo.save(user);
    if (repIds) await this.repScope.setScope(id, repIds);
    return saved;
  }

  /** The salesmen assigned to a scoped user (empty for unrestricted ones). */
  async scopeOf(id: string): Promise<string[]> {
    return this.repScope.getScope(id);
  }

  async changePassword(id: string, newPassword: string): Promise<void> {
    const user = await this.findOneOrThrow(id);
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.mustChangePassword = false; // they've now set their own
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

  /** Every active user (flat, unpaginated) — for the app's permissions screen. */
  async listAll(): Promise<User[]> {
    return this.usersRepo.find({ order: { name: 'ASC' } });
  }
}
