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
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ACCESS_TOKEN_COOKIE, accessTokenCookieOptions } from '../../common/auth/auth-cookie';

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
    description: 'Clears the httpOnly access-token cookie. Safe to call without a valid session.',
  })
  @ApiOkResponse({ description: 'Cookie cleared' })
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
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
