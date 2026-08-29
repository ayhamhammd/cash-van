import { EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { Rep } from './entities/rep.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { User } from '../users/entities/user.entity';

/** Default login for an auto-provisioned salesman; forced change on first login. */
export const DEFAULT_SALESMAN_PASSWORD = 'Van@1234';
const BCRYPT_ROUNDS = 12;

export interface ProvisionRepInput {
  code: string;
  nameAr: string;
  nameEn?: string | null;
  phone?: string | null;
  regionId?: string | null;
  /** Link an existing user instead of creating one (dashboard "link user"). */
  userId?: string | null;
  isActive?: boolean;
  hireDate?: string | null;
  dailyQuotaFils?: number | null;
  /** Commission rate percentage (0–100), stored as a numeric string on the rep. */
  commissionPct?: string | null;
  erpAccountId?: string | null;
  erpAccountCode?: string | null;
  /**
   * Start this salesman frozen — they exist and can be seen, but cannot sign in
   * until a key is entered. Set by the caller from the installation's
   * `salesmanActivationEnabled` flag, so a client who never turns licensing on
   * provisions exactly as before.
   */
  frozen?: boolean;
}

/**
 * Provision a salesman end-to-end inside an existing transaction. The salesman
 * code is the single shared identity: store (whNumber=code), login user
 * (userNumber=code), and the rep linking both. Existing store/user with that
 * code are reused (not duplicated), so this is safe to call idempotently from
 * the ERP pull where the store may already be synced. Does NOT push to the ERP
 * — the caller decides that.
 */
export async function provisionRep(
  em: EntityManager,
  input: ProvisionRepInput,
): Promise<Rep> {
  const repRepo = em.getRepository(Rep);
  const whRepo = em.getRepository(Warehouse);
  const userRepo = em.getRepository(User);
  const code = input.code;
  const displayName = input.nameAr || input.nameEn || code;

  // Store: number == salesman code.
  let store = await whRepo.findOne({ where: { whNumber: code } });
  if (!store) {
    store = whRepo.create({ whNumber: code, whName: displayName });
    await whRepo.save(store);
  }

  // Login: userNumber == salesman code (unless an existing user was linked).
  let userId = input.userId ?? null;
  if (!userId) {
    let user = await userRepo.findOne({ where: { userNumber: code } });
    if (!user) {
      user = userRepo.create({
        userNumber: code,
        name: displayName,
        nameAr: input.nameAr ?? null,
        nameEn: input.nameEn ?? null,
        userType: 'SALES',
        role: 'viewer',
        passwordHash: await bcrypt.hash(DEFAULT_SALESMAN_PASSWORD, BCRYPT_ROUNDS),
        mustChangePassword: true,
        isActive: true,
        canMakeVoucher: true,
        canCreateSale: true,
        canCreateReturn: true,
        canMakeCollection: true,
        canAddCustomer: true,
      });
      await userRepo.save(user);
    }
    userId = user.id;
  }

  const rep = repRepo.create({
    code,
    nameAr: input.nameAr,
    nameEn: input.nameEn ?? null,
    phone: input.phone ?? null,
    regionId: input.regionId ?? null,
    isActive: input.isActive ?? true,
    hireDate: input.hireDate ?? null,
    dailyQuotaFils: input.dailyQuotaFils ?? null,
    commissionPct: input.commissionPct ?? '0',
    erpAccountId: input.erpAccountId ?? null,
    erpAccountCode: input.erpAccountCode ?? null,
    // Defaults to unfrozen: a caller that knows nothing about licensing must
    // never accidentally lock a salesman out.
    isFrozen: input.frozen ?? false,
    vanId: store.id,
    userId,
  });
  await repRepo.save(rep);
  return rep;
}
