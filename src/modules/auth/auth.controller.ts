import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
      'Authenticate by userNumber + password. Returns a JWT access token plus the user profile. This is the only public endpoint — paste the returned `accessToken` into Authorize.',
  })
  @ApiOkResponse({ description: 'Login succeeded; access token returned' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
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
