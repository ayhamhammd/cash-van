import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
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
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ACCESS_TOKEN_COOKIE, accessTokenCookieOptions } from '../../common/auth/auth-cookie';
import { DEVICE_COOKIE, newDeviceId } from '../login-approvals/login-approvals.service';

/** The browser's device id outlives every session: five years. */
const DEVICE_COOKIE_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/**
 * The browser's device id, issued on its first web sign-in. Read and set by the
 * API itself (httpOnly), so page script can neither see nor copy it.
 */
function webDevice(req: Request, res: Response) {
  let raw = (req.cookies as Record<string, string> | undefined)?.[DEVICE_COOKIE];
  if (!raw || raw.length < 32) raw = newDeviceId();
  res.cookie(DEVICE_COOKIE, raw, { ...accessTokenCookieOptions(), maxAge: DEVICE_COOKIE_MAX_AGE_MS });
  return { raw, userAgent: req.headers['user-agent'] ?? null, ip: req.ip ?? null };
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @SkipAudit()
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
    // A web sign-in (no mobile deviceId) carries the browser's device cookie, so
    // the optional administrator approval can recognise trusted browsers.
    const web = dto.deviceId ? undefined : webDevice(req, res);
    const result = await this.authService.login(dto, web);
    if ('approvalRequired' in result) return result;
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

  @Public()
  @SkipAudit()
  @Post('login-requests/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish a sign-in that was waiting for an administrator',
    description:
      'Polled by the browser that asked. Returns `{ status }` while pending, rejected or expired; ' +
      'once approved it signs in exactly like a normal login. Only the browser holding the same ' +
      'device cookie can complete it, and an approval works once.',
  })
  async completeLogin(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[DEVICE_COOKIE];
    const result = await this.authService.completeApproved(id, raw);
    if (!result.session) return { status: result.status };
    res.cookie(ACCESS_TOKEN_COOKIE, result.session.accessToken, accessTokenCookieOptions());
    if (req.headers['x-client-type'] === 'web') {
      return { status: 'approved', user: result.session.user };
    }
    return { status: 'approved', ...result.session };
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
