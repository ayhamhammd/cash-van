import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Rep } from '../reps/entities/rep.entity';
import { AppSettings } from '../settings/entities/app-settings.entity';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { MobileContext } from './mobile.context';

interface MobileRequest {
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  mobileCtx?: MobileContext;
}

/**
 * Validates the contract's common params on every mobile endpoint:
 *   - `companyNumber` (query `companyNumber` or header `X-Company-Number`) must
 *     match the single-tenant `app_settings.company_number`.
 *   - `salesmanCode` (route param, query `salesmanCode`, or header
 *     `X-Salesman-Code`) must resolve to a rep.
 *   - if the caller's token is itself a salesman, the code must be their own.
 * Resolved context is attached as `req.mobileCtx`.
 */
@Injectable()
export class MobileContextGuard implements CanActivate {
  constructor(
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
    @InjectRepository(AppSettings)
    private readonly settings: Repository<AppSettings>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<MobileRequest>();

    const companyNumber = pick(req, 'companyNumber', 'x-company-number');
    const salesmanCode =
      req.params?.salesmanCode ?? pick(req, 'salesmanCode', 'x-salesman-code');

    if (!companyNumber) {
      throw new BadRequestException('companyNumber is required (query or X-Company-Number header)');
    }
    if (!salesmanCode) {
      throw new BadRequestException('salesmanCode is required (query or X-Salesman-Code header)');
    }

    const row = await this.settings.findOne({ where: { id: 1 } });
    if (!row) throw new NotFoundException('app_settings row missing — re-run migrations');
    if (companyNumber !== row.companyNumber) {
      throw new BadRequestException(`Unknown companyNumber "${companyNumber}"`);
    }

    const rep = await this.reps.findOne({
      where: { code: salesmanCode, deletedAt: IsNull() },
    });
    if (!rep) {
      throw new NotFoundException(`Salesman "${salesmanCode}" not found`);
    }

    // Admins/managers may query any salesman; a salesman token may only act as itself.
    const user = req.user;
    const privileged = user?.role === 'admin' || user?.role === 'manager';
    if (!privileged && user?.repId && user.repId !== rep.id) {
      throw new ForbiddenException('Salesman not authorized for this account');
    }

    req.mobileCtx = { companyNumber: row.companyNumber, salesmanCode, rep };
    return true;
  }
}

function pick(req: MobileRequest, queryKey: string, headerKey: string): string | undefined {
  const q = req.query?.[queryKey];
  if (q) return q;
  const h = req.headers?.[headerKey];
  return Array.isArray(h) ? h[0] : h ?? undefined;
}
