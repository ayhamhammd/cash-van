import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  sub: string;
  userNumber: string;
  userType: string;
  role: string;
  permissions: Record<string, boolean>;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return data ? req.user?.[data] : req.user;
  },
);
