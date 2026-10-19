import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import { InternalSecretGuard } from './internal-secret.guard';
import { SetAdminPasswordDto, SetServiceKeyDto } from './dto/service-key.dto';
import { TenantsService } from './tenants.service';

/**
 * Things the CRM sets into this company that are not the company itself.
 *
 * Its own controller rather than another route under `internal/tenants`,
 * because these are not about creating or removing a company — they are about
 * configuring one that already exists, and a URL should say which of those it
 * is doing.
 *
 * Same shared secret, same reason: the caller is the control plane, not a
 * person, and no user of any company should be able to reach any of it.
 */
@ApiExcludeController()
@Controller({ path: 'internal', version: '1' })
@UseGuards(InternalSecretGuard)
export class InternalServiceController {
  constructor(private readonly tenants: TenantsService) {}

  /**
   * A third-party key the CRM is putting into this company.
   *
   * The Google Maps key, the AI key, the JoFotara secret. Set once in the
   * control plane and pushed here, so nobody has to paste the same credential
   * into a second place — which is how a company ended up with a working key in
   * the CRM and an empty box in the app.
   *
   * The settings screen still works and still wins for anyone typing in it. An
   * on-premise site never receives this call at all: we cannot reach that
   * machine, and its keys are its own business.
   */
  @Public()
  @Post('service-keys')
  @HttpCode(HttpStatus.OK)
  setServiceKey(
    @Body() dto: SetServiceKeyDto,
  ): Promise<{ stored: boolean; reason?: string }> {
    return this.tenants.setServiceKey(dto);
  }

  /**
   * A new password for this company's super admin, set in the CRM.
   *
   * Sent whenever it is reset there. Without it the CRM login would work and
   * the product the customer actually uses would not — which is the opposite of
   * the problem they rang about.
   */
  @Public()
  @Post('admin-password')
  @HttpCode(HttpStatus.OK)
  setAdminPassword(
    @Body() dto: SetAdminPasswordDto,
  ): Promise<{ updated: boolean; reason?: string }> {
    return this.tenants.setAdminPassword(dto);
  }
}
