/**
 * Convert any thrown value into a human-readable string.
 *
 * The opencode SDK rejects with discriminated-union plain objects (e.g.
 * `ApiError`, `BadRequestError` shaped as `{ data, error/errors, success }`)
 * that are not `Error` instances, so `String(err)` produces "[object Object]"
 * by default. This helper extracts something useful in that case.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    // SDK's BadRequestError shape: { data, error: [{message, ...}], success: false }
    if (Array.isArray(o.error) && o.error.length > 0) {
      const first = o.error[0] as { message?: unknown; path?: unknown };
      if (typeof first.message === "string") {
        const path = Array.isArray(first.path) && first.path.length > 0
          ? ` at ${first.path.join(".")}`
          : "";
        return `${first.message}${path}`;
      }
    }
    // Some SDK shapes use `errors` (plural)
    if (Array.isArray(o.errors) && o.errors.length > 0) {
      const first = o.errors[0] as { message?: unknown };
      if (typeof first.message === "string") return first.message;
    }
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
