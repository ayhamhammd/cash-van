import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, ILike, IsNull, Not, Repository } from 'typeorm';

import { Rep } from './entities/rep.entity';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { provisionRep } from './rep-provision';
import { verifyActivationKey } from './activation-key';
import { CreateRepDto } from './dto/create-rep.dto';
import { UpdateRepDto } from './dto/update-rep.dto';
import { ListRepsQuery } from './dto/list-reps.query';

export interface RepKpis {
  todayRevenueFils: number;
  routeCompletionPct: number;
  invoicesToday: number;
  customersAtRisk: number;
}

/**
 * A uuid that matches no rep. TypeORM's IN (:...x) renders invalid SQL for an
 * empty array, so an empty scope needs a sentinel that reliably matches nothing.
 */
const NO_REPS = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class RepsService {
  constructor(
    @InjectRepository(Rep)
    private readonly repo: Repository<Rep>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly erpSync: ErpSyncService,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
  ) {}

  /**
   * @param visibleRepIds null = unrestricted; an array (possibly empty) limits
   *   the list to those reps. See docs/SPEC-rep-scoped-users.md.
   */
  async list(
    query: ListRepsQuery,
    visibleRepIds: string[] | null = null,
  ): Promise<{ items: Rep[]; total: number }> {
    const qb = this.repo
      .createQueryBuilder('rep')
      .where('rep.deleted_at IS NULL')
      .orderBy('rep.name_ar', 'ASC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);

    // Empty array must yield NOTHING, so this is a plain IN — not a
    // `if (length)` guard, which would hand a scoped user the whole list.
    if (visibleRepIds !== null) {
      qb.andWhere('rep.id IN (:...visibleRepIds)', {
        visibleRepIds: visibleRepIds.length ? visibleRepIds : [NO_REPS],
      });
    }
    if (query.regionId) {
      qb.andWhere('rep.region_id = :regionId', { regionId: query.regionId });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('rep.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.q) {
      qb.andWhere(
        new Brackets((b) => {
          const pattern = `%${query.q}%`;
          b.where('rep.name_ar ILIKE :p', { p: pattern })
            .orWhere('rep.name_en ILIKE :p', { p: pattern })
            .orWhere('rep.phone ILIKE :p', { p: pattern });
        }),
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /** Whether this installation locks new salesmen behind an activation key. */
  private async activationEnabled(): Promise<boolean> {
    // Never let a settings read failure decide a lock: default to NOT freezing,
    // so a transient error cannot silently lock a client out of their own reps.
    return this.settings.salesmanActivationEnabled().catch(() => false);
  }

  /**
   * Unfreeze a salesman with their activation key.
   *
   * Idempotent: activating an already-active salesman succeeds without changing
   * anything, so a double-tap on a slow connection is not an error the user has
   * to interpret.
   */
  async activate(id: string, key: string, actorId: string | null): Promise<Rep> {
    const rep = await this.findOne(id);
    if (!rep.isFrozen) return rep;

    const secret = process.env.SALESMAN_ACTIVATION_SECRET ?? '';
    if (!secret) {
      // Refuse rather than accept anything: with no secret every key would
      // "work", which is worse than being unable to activate at all.
      throw new BadRequestException(
        'Activation is not configured on this server (SALESMAN_ACTIVATION_SECRET is unset).',
      );
    }
    if (!rep.code) {
      throw new BadRequestException(
        'This salesman has no code, so no key can be issued for them.',
      );
    }
    if (!verifyActivationKey(rep.code, key ?? '', { secret })) {
      throw new BadRequestException('Activation key is not valid for this salesman.');
    }

    rep.isFrozen = false;
    rep.activatedAt = new Date();
    rep.activatedBy = actorId;
    return this.repo.save(rep);
  }

  async findOne(id: string): Promise<Rep> {
    const rep = await this.repo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!rep) throw new NotFoundException(`Rep ${id} not found`);
    return rep;
  }

  /** Resolve the rep linked to a dashboard user (1:1), or null if unlinked. */
  async findByUserId(userId: string): Promise<Rep | null> {
    return this.repo.findOne({ where: { userId, deletedAt: IsNull() } });
  }

  async findByUserIdOrThrow(userId: string): Promise<Rep> {
    const rep = await this.findByUserId(userId);
    if (!rep) {
      throw new NotFoundException('No rep is linked to this user account');
    }
    return rep;
  }

  /** KPIs for the rep linked to the current user (used by /reps/me/kpis). */
  async kpisForUser(userId: string): Promise<RepKpis> {
    const rep = await this.findByUserIdOrThrow(userId);
    return this.kpis(rep.id);
  }

  /** Resolve the rep with this salesman code (used by the mobile BFF). */
  async findByCode(code: string): Promise<Rep | null> {
    return this.repo.findOne({ where: { code, deletedAt: IsNull() } });
  }

  /**
   * Create a salesman. Every salesman is provisioned end-to-end in one
   * transaction: a store (warehouse) whose number == the salesman code, and a
   * login user whose userNumber == the salesman code (default password, forced
   * change on first login). The store is linked back as the rep's van, and the
   * van warehouse is mirrored into the ERP. The salesman code is therefore the
   * single identity shared across rep ⇄ store (stock_number) ⇄ login ⇄ ERP
   * warehouse. Pass `userId` to link an existing user instead of creating one.
   */
  async create(dto: CreateRepDto): Promise<Rep> {
    if (!dto.code) {
      throw new BadRequestException(
        'A salesman code is required — it becomes the store number and login',
      );
    }
    if (dto.vanId) {
      throw new BadRequestException(
        'A store is auto-created for every salesman; do not pass an existing vanId',
      );
    }
    if (dto.userId) await this.assertUserUnlinked(dto.userId);
    await this.assertCodeUnique(dto.code);

    // Licensing: a salesman created from the dashboard is frozen on arrival when
    // the installation has activation switched on, exactly like one arriving
    // from the ERP. Both routes go through provisionRep for that reason.
    const frozen = await this.activationEnabled();

    const rep = await this.dataSource.transaction((em) =>
      provisionRep(em, {
        frozen,
        code: dto.code!,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        phone: dto.phone,
        regionId: dto.regionId,
        userId: dto.userId,
        isActive: dto.isActive,
        hireDate: dto.hireDate,
        dailyQuotaFils: dto.dailyQuotaFils,
        erpAccountId: dto.erpAccountId,
        erpAccountCode: dto.erpAccountCode,
      }),
    );

    // Mirror the new salesman's van store into the ERP (best-effort; no-op when ERP off).
    if (rep.code) {
      await this.erpSync.pushWarehouse(rep.code, rep.nameAr || rep.nameEn || rep.code, true);
    }

    return rep;
  }

  async update(id: string, dto: UpdateRepDto): Promise<Rep> {
    const rep = await this.findOne(id);
    const { password, ...fields } = dto;

    // When working WITH the ERP, the salesman's identity (name + code/userNumber)
    // is ERP-managed and must not be changed here. Everything else (phone, region,
    // quota, active, hire date, and the login password) stays editable.
    const erpOn = (await this.settings.getErpConfig().catch(() => null))?.enabled;
    if (erpOn) {
      delete fields.code; // == userNumber / store number
      delete fields.nameAr;
      delete fields.nameEn;
    }

    if (fields.userId) await this.assertUserUnlinked(fields.userId, id);
    if (fields.code) await this.assertCodeUnique(fields.code, id);
    Object.assign(rep, fields);
    const saved = await this.repo.save(rep);

    // Set/change the salesman's login password on the linked user.
    if (password) {
      if (!rep.userId) {
        throw new BadRequestException(
          'This salesman has no linked login user, so a password cannot be set',
        );
      }
      await this.users.changePassword(rep.userId, password);
    }
    return saved;
  }

  private async assertCodeUnique(code: string, exceptRepId?: string): Promise<void> {
    const existing = await this.repo.findOne({
      where: exceptRepId
        ? { code, id: Not(exceptRepId), deletedAt: IsNull() }
        : { code, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(`Salesman code "${code}" is already in use`);
    }
  }

  /** Guard the 1:1 user↔rep invariant before it hits the unique index. */
  private async assertUserUnlinked(
    userId: string,
    exceptRepId?: string,
  ): Promise<void> {
    const existing = await this.repo.findOne({
      where: exceptRepId
        ? { userId, id: Not(exceptRepId), deletedAt: IsNull() }
        : { userId, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(
        `User ${userId} is already linked to rep ${existing.id}`,
      );
    }
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.repo.softDelete({ id });
    if (!result.affected) {
      throw new NotFoundException(`Rep ${id} not found`);
    }
  }

  /** Stub — populated by plan 06 (invoices) once revenue data exists. */
  async kpis(id: string): Promise<RepKpis> {
    await this.findOne(id); // 404 if missing
    return {
      todayRevenueFils: 0,
      routeCompletionPct: 0,
      invoicesToday: 0,
      customersAtRisk: 0,
    };
  }
}

// Avoid "unused" lint on ILike (kept for future ILike usage).
void ILike;
