import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { Customer } from './entities/customer.entity';
import { CustomersService } from './customers.service';
import { User } from '../users/entities/user.entity';
import { UserContextService } from '../../common/context/user-context.service';
import { haversineMeters } from '../../common/geo/geo.util';

/**
 * Rep permission key. When present on a rep's `user.permissions`, that rep is
 * "location-locked": they may only sell / act on a customer while physically
 * within the configured geofence of that customer's saved location. Absent
 * (the default) → the rep can act on any customer from anywhere.
 */
export const PERM_REQUIRE_PROXIMITY = 'customers.requireProximity';

/**
 * Enforces the per-rep location lock for customer-scoped actions (sales,
 * returns, request vouchers, collections). Bootstraps a missing customer
 * location from the rep's own GPS on first contact (seed-once — see
 * {@link CustomersService.seedLocation}). No-op for admins/managers, internal
 * (context-less) calls, unrestricted reps, and actions with no customer.
 *
 * The rep's coordinates are stamped by the client at action time and
 * re-validated here — so an offline sale synced later is checked against the
 * position the rep was actually at, not a stale server-tracked ping.
 */
@Injectable()
export class CustomerProximityService {
  private readonly logger = new Logger(CustomerProximityService.name);
  private readonly radiusM: number;

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly customersService: CustomersService,
    private readonly userCtx: UserContextService,
    config: ConfigService,
  ) {
    this.radiusM = Number(config.get('geofence.radiusM')) || 1000;
  }

  async enforce(input: {
    customerNumber?: string | null;
    customerId?: string | null;
    repLat?: number | null;
    repLng?: number | null;
  }): Promise<void> {
    const ctx = this.userCtx.get();
    if (!ctx) return; // internal call (job / approval execution) — trusted
    if (ctx.role === 'admin' || ctx.role === 'manager') return;

    const user = await this.users.findOne({ where: { id: ctx.userId } });
    if (!user || user.userType === 'ADMIN') return;
    if (!(user.permissions ?? []).includes(PERM_REQUIRE_PROXIMITY)) return; // sells anywhere

    // Resolve the customer this action targets. No customer → not a
    // customer-scoped action (e.g. van loading / stock transfer) → lock N/A.
    const customer = input.customerId
      ? await this.customers.findOne({ where: { id: input.customerId } })
      : input.customerNumber
        ? await this.customers.findOne({
            where: { customerNumber: input.customerNumber },
          })
        : null;
    if (!customer) return; // unknown / no customer — let the main flow decide

    const repLat = this.coord(input.repLat, 90);
    const repLng = this.coord(input.repLng, 180);
    const hasFix = repLat !== null && repLng !== null;

    const custLat = this.coord(customer.latitude, 90);
    const custLng = this.coord(customer.longitude, 180);
    const hasLoc = custLat !== null && custLng !== null;

    if (!hasLoc) {
      // Bootstrap: stamp the rep's position as the store location (seed-once,
      // only writes while it is still null). Can't seed without a GPS fix.
      if (!hasFix) throw this.needLocation();
      await this.customersService.seedLocation(customer.id, repLat!, repLng!);
      return; // the rep is, by definition, at the location just captured
    }

    if (!hasFix) throw this.needLocation();
    const dist = haversineMeters(repLat!, repLng!, custLat!, custLng!);
    if (dist > this.radiusM) {
      throw new ForbiddenException({
        code: 'outside_customer_geofence',
        message:
          `يجب أن تكون في موقع العميل لإتمام العملية — ` +
          `You must be at the customer's location (within ${this.radiusM} m; you are ~${Math.round(dist)} m away).`,
        distanceM: Math.round(dist),
        radiusM: this.radiusM,
      });
    }
  }

  private needLocation(): ForbiddenException {
    return new ForbiddenException({
      code: 'location_required',
      message:
        'يجب تفعيل الموقع (GPS) لإتمام العملية — ' +
        'Enable location (GPS) to act on this customer.',
    });
  }

  /** Parse a coord to a finite number in [-max, max], else null. */
  private coord(
    v: string | number | null | undefined,
    max: number,
  ): number | null {
    const n =
      typeof v === 'number' ? v : v == null ? Number.NaN : Number.parseFloat(v);
    return Number.isFinite(n) && n >= -max && n <= max ? n : null;
  }
}
