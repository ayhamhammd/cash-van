import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  sub: string;
  userNumber: string;
  userType: string;
  role: string;
  /** Field-rep id linked to this user, or null if the user isn't a rep. */
  repId: string | null;
  permissions: Record<string, boolean>;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return data ? req.user?.[data] : req.user;
  },
);
