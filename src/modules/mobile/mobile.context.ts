import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Rep } from '../reps/entities/rep.entity';

/** Resolved per-request mobile context (set by MobileContextGuard). */
export interface MobileContext {
  companyNumber: string;
  salesmanCode: string;
  rep: Rep;
}

interface RequestWithMobileCtx {
  mobileCtx?: MobileContext;
}

/** Injects the resolved MobileContext into a handler. */
export const MobileCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MobileContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithMobileCtx>();
    return req.mobileCtx as MobileContext;
  },
);
