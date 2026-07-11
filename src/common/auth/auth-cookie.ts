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
  // The dashboard and API are deployed on separate subdomains (e.g. *.onrender.com, which
  // the browser treats as CROSS-SITE), so a SameSite=lax cookie is never sent on the
  // dashboard's XHR and every call 401s. Default to 'none' (auto-Secure) in production so
  // the cross-site cookie IS sent; keep 'lax' for local same-site dev (localhost ↔ localhost).
  // Override with COOKIE_SAMESITE=lax when the dashboard + API share one registrable domain.
  const sameSite = (process.env.COOKIE_SAMESITE as CookieOptions['sameSite'])
    ?? (isProd ? 'none' : 'lax');
  // A Secure cookie is dropped by browsers over plain HTTP (except on localhost).
  // Cloud (HTTPS) wants Secure; an on-prem LAN box on http://<device-ip> can't use
  // it — set COOKIE_SECURE=false there (same-origin proxy + SameSite=lax keeps it
  // working). Default: Secure in prod or whenever SameSite=none (which requires it).
  const secure =
    process.env.COOKIE_SECURE != null
      ? process.env.COOKIE_SECURE === 'true'
      : isProd || sameSite === 'none';
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  };
}
