import type { CookieOptions } from 'express';

/**
 * The httpOnly cookie that carries the access JWT for browser clients. Because it is
 * httpOnly it is invisible to page JavaScript (not in storage, not stealable via XSS) and
 * is sent automatically with same-site requests. Mobile/API clients keep using the
 * `Authorization: Bearer` header instead. See docs/SPEC — auth cookie hardening.
 */
export const ACCESS_TOKEN_COOKIE = 'access_token';

/** Keep in sync with JWT_EXPIRES_IN (default 12h). */
export const ACCESS_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function accessTokenCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  // SameSite=lax gives CSRF protection (cross-site POSTs don't carry the cookie) while
  // still working for same-site XHR (dashboard ↔ api on the same registrable domain).
  // If the API is served from a DIFFERENT site than the dashboard, set COOKIE_SAMESITE=none
  // (which forces Secure) so the cross-site cookie is still sent.
  const sameSite = (process.env.COOKIE_SAMESITE as CookieOptions['sameSite']) ?? 'lax';
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  };
}
