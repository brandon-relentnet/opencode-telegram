import type { Context, MiddlewareFn } from "grammy";

export function whitelistMiddleware(allowedUserIds: number[]): MiddlewareFn<Context> {
  const allow = new Set(allowedUserIds);
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (id !== undefined && allow.has(id)) {
      await next();
      return;
    }
    // Drop silently. The caller is expected to log via pino at info level.
  };
}
