import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { Public } from '../../common/decorators/public.decorator';
import { AllowWhenSuspended } from '../../common/licensing/allow-when-suspended.decorator';
import { AllowInvalidLicense } from '../../common/licensing/allow-invalid-license.decorator';
import { LicenseContext } from '../../common/licensing/license-context.service';
import { LicenseService } from '../../common/licensing/license.service';
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ACCESS_TOKEN_COOKIE, accessTokenCookieOptions } from '../../common/auth/auth-cookie';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly licenses: LicenseService,
    private readonly licenseCtx: LicenseContext,
  ) {}

  /**
   * What company does the presented licence key belong to?
   *
   * The login screen calls this before anyone types a password, and shows the
   * company name back. Without it a mistyped key and a wrong password are the
   * same event to the person signing in: an unrecognised key falls through to
   * the default company, where their user does not exist, and they are told
   * "Invalid credentials" — while staring at a correct password.
   *
   * Public, and safe to be: you must already hold the key to learn anything,
   * and all you learn is which company it belongs to and what it entitles —
   * the same trade the CRM's own validate endpoint makes. It authenticates
   * nobody.
   */
  @Public()
  @SkipAudit()
  @AllowWhenSuspended()
  // The one endpoint that must answer even for a revoked key — otherwise the
  // login screen cannot say why it is refusing.
  @AllowInvalidLicense()
  @Get('license')
  @ApiOperation({
    summary: 'Describe the licence key sent with this request',
    description:
      'Send the key as `x-license-key`. `licensingEnabled: false` means this install is not ' +
      'centrally licensed at all (a single-company or on-premise deployment) and clients should ' +
      'stop asking for a key. `recognised: false` means the key is unknown, expired or revoked.',
  })
  @ApiOkResponse({ description: 'The company the key resolves to, if any' })
  license() {
    if (!this.licenses.enabled) return { licensingEnabled: false, recognised: false };
    const info = this.licenseCtx.get();
    // A revoked key is reported as unrecognised on purpose. To the person at
    // the login screen the two are the same event — "this key will not get you
    // in" — and the message they already see covers both. Naming revocation
    // specifically would only tell whoever stole the key that they found a real
    // one and should look for a newer copy.
    if (!info?.tenantId || !info.valid) {
      return { licensingEnabled: true, recognised: false };
    }
    return {
      licensingEnabled: true,
      recognised: true,
      tenantCode: info.tenantCode,
      tenantName: info.tenantName,
      features: info.features,
      // False when unpaid or expired. The client warns before they sign in
      // rather than after they have filled in a form they cannot save.
      writesAllowed: info.writesAllowed,
    };
  }

  @Public()
  @SkipAudit()
  // Signing in is a POST but changes nothing, and an unpaid company must still
  // be able to reach and export its own records.
  @AllowWhenSuspended()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in',
    description:
      'Authenticate by userNumber + password. Sets an httpOnly `access_token` cookie. ' +
      'Web clients (header `x-client-type: web`) get only the user profile back — the token ' +
      'stays in the cookie and never reaches page JS. Other clients (mobile/API) also receive ' +
      '`accessToken` in the body for `Authorization: Bearer` use.',
  })
  @ApiOkResponse({ description: 'Login succeeded; token set as httpOnly cookie' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    // Always set the httpOnly cookie so the browser is authenticated without exposing the JWT.
    res.cookie(ACCESS_TOKEN_COOKIE, result.accessToken, accessTokenCookieOptions());
    // Web clients rely purely on the cookie — don't echo the token back to the browser.
    if (req.headers['x-client-type'] === 'web') {
      return { user: result.user };
    }
    return result;
  }

  @Public()
  @SkipAudit()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Clears the httpOnly access-token cookie. Safe to call without a valid ' +
      'session. A mobile client may pass `deviceId` to mark its session ' +
      'closed — this deliberately does NOT release the device binding or ' +
      'revoke the tracking token, so the handset keeps reporting its ' +
      'position after the salesman signs out. Only the office releasing the ' +
      'device stops that.',
  })
  @ApiOkResponse({ description: 'Cookie cleared' })
  async logout(
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LogoutDto,
  ) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    // Public route, so there is no authenticated user to check against. That is
    // acceptable here because the only effect is clearing `session_jti`, a
    // bookkeeping flag the office reads; it grants nothing and revokes nothing.
    if (dto?.deviceId) await this.authService.closeDeviceSession(dto.deviceId);
    return { ok: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Current user',
    description: 'Returns the authenticated user decoded from the bearer JWT.',
  })
  @ApiOkResponse({ description: 'The authenticated user' })
  me(@CurrentUser() user: AuthenticatedUser) {
    // Re-read fresh permissions from the DB (the JWT claims are from login time),
    // so the app picks up dashboard permission changes on its next refresh.
    return this.authService.profile(user as unknown as { sub: string });
  }
}
