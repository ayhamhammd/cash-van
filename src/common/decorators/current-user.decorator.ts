import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  sub: string;
  userNumber: string;
  userType: string;
  role: string;
  /** Field-rep id linked to this user, or null if the user isn't a rep. */
  repId: string | null;
  permissions: Record<string, boolean>;
  /**
   * Set only for a long-lived device tracking token. Its presence is what
   * `TrackingTokenGuard` keys off to confine the caller to telemetry routes —
   * an ordinary session leaves it undefined.
   */
  trackingJti?: string;
  /** Handset the token was issued to; only on tracking tokens. */
  deviceId?: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return data ? req.user?.[data] : req.user;
  },
);
