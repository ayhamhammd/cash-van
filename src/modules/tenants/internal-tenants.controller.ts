import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import { InternalSecretGuard } from './internal-secret.guard';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { LinkErpDto } from './dto/link-erp.dto';
import { Tenant } from './entities/tenant.entity';
import { TenantsService } from './tenants.service';

/**
 * Service-to-service provisioning, called by the CRM control plane.
 *
 * `@Public()` only bypasses the JWT guard — `InternalSecretGuard` still gates
 * every route. These endpoints take a shared secret rather than a user token
 * because they create companies, which no user of any company should be able
 * to do.
 *
 * Excluded from Swagger: it is not part of the customer-facing API, and
 * publishing it only advertises an endpoint worth attacking.
 */
@ApiExcludeController()
@Controller({ path: 'internal/tenants', version: '1' })
@UseGuards(InternalSecretGuard)
export class InternalTenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Public()
  @Post()
  provision(@Body() dto: ProvisionTenantDto): Promise<Tenant> {
    return this.tenants.provision(dto);
  }

  /**
   * The CRM telling us which ERP this company uses.
   *
   * Sent when a company has been provisioned into both products, so the pair
   * introduce themselves without anyone typing an address into a settings
   * screen. Fills in only what is empty — see `linkErp`.
   */
  @Public()
  @Post(':crmTenantId/erp-link')
  @HttpCode(HttpStatus.OK)
  linkErp(
    @Param('crmTenantId') crmTenantId: string,
    @Body() dto: LinkErpDto,
  ): Promise<{ linked: boolean; reason?: string }> {
    return this.tenants.linkErp({ crmTenantId, ...dto });
  }

  /**
   * The CRM deleting its own record for this company.
   *
   * We archive rather than delete: their data is theirs, and the CRM is not
   * the system of record for it. This frees the code so the same one can be
   * used again, and unlinks the row so no future CRM company inherits it.
   */
  @Public()
  @Delete(':crmTenantId')
  archive(
    @Param('crmTenantId') crmTenantId: string,
  ): Promise<{ archived: boolean }> {
    return this.tenants.archive(crmTenantId);
  }

  @Public()
  @Get()
  list(): Promise<Tenant[]> {
    return this.tenants.list();
  }
}
