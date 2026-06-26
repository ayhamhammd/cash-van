import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { SettingsService } from '../../modules/settings/settings.service';

/**
 * Blocks write requests (create/edit/delete) on ERP-managed base data while the
 * ERP integration is ON — that data is owned by the ERP and pulled into FlowVan,
 * so it must be edited in the ERP, not here. Apply with `@UseGuards(ErpReadOnlyGuard)`
 * on the specific write endpoints (items, categories, units, customers, stores,
 * salesmen, company info, vendors). Reads (GET) are never affected.
 */
@Injectable()
export class ErpReadOnlyGuard implements CanActivate {
  constructor(private readonly settings: SettingsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ method: string }>();
    const method = (req?.method ?? 'GET').toUpperCase();
    // Reads always pass; only writes are gated. Safe to apply at controller level.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    const cfg = await this.settings.getErpConfig().catch(() => null);
    if (cfg?.enabled) {
      throw new ForbiddenException(
        'This data is managed by the ERP. Create or edit it in the ERP system; FlowVan syncs it automatically.',
      );
    }
    return true;
  }
}
