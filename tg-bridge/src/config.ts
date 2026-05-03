import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const trimmedNonEmpty = (msg: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, msg));

const optionalTrimmed = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1))
  .optional();

// Format: <providerID>/<modelID>, e.g. "anthropic/claude-sonnet-4-5".
// Identifiers can include alphanumerics, dot, underscore, and dash.
const MODEL_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const modelId = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .regex(MODEL_ID_RE, "must be in the form <providerID>/<modelID>"),
  );

// Note: Telegram user IDs > 2^53 lose precision via JSON.parse, matching grammy's Context["from"]["id"]: number contract.
const userIdList = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Not a positive integer: ${JSON.stringify(s)}`,
          });
          return z.NEVER;
        }
        return n;
      });
    if (ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must contain at least one ID",
      });
      return z.NEVER;
    }
    return ids;
  });

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: trimmedNonEmpty("TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: userIdList,
  OPENCODE_URL: z.string().url().default("http://opencode:4096"),
  OPENCODE_USERNAME: trimmedNonEmpty("OPENCODE_USERNAME is required").default("opencode"),
  OPENCODE_PASSWORD: trimmedNonEmpty("OPENCODE_PASSWORD is required"),
  WORKSPACE_ROOT: z.string().min(1).default("/workspace"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  // Default model used when chat-state has no per-chat model override.
  // Without this, opencode picks its own default which may not match the
  // provider account the bridge has authenticated against.
  DEFAULT_MODEL: modelId.default("anthropic/claude-sonnet-4-5"),
  // GitHub integration (used by /init-remote)
  GH_TOKEN: optionalTrimmed,
  GH_OWNER: optionalTrimmed,
  // Coolify integration (used by /deploy)
  COOLIFY_URL: z.string().url().optional(),
  COOLIFY_TOKEN: optionalTrimmed,
  COOLIFY_SERVER_UUID: optionalTrimmed,
  COOLIFY_PROJECT_UUID: optionalTrimmed,
  COOLIFY_GITHUB_APP_UUID: optionalTrimmed,
});

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  workspaceRoot: string;
  logLevel: LogLevel;
  defaultModel: string;
  // Optional integration fields. Commands gate on presence at invocation time.
  ghToken: string | undefined;
  ghOwner: string | undefined;
  coolifyUrl: string | undefined;
  coolifyToken: string | undefined;
  coolifyServerUuid: string | undefined;
  coolifyProjectUuid: string | undefined;
  coolifyGithubAppUuid: string | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = Schema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${messages}`);
  }
  const parsed = result.data;
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS,
    opencodeUrl: parsed.OPENCODE_URL,
    opencodeUsername: parsed.OPENCODE_USERNAME,
    opencodePassword: parsed.OPENCODE_PASSWORD,
    workspaceRoot: parsed.WORKSPACE_ROOT,
    logLevel: parsed.LOG_LEVEL,
    defaultModel: parsed.DEFAULT_MODEL,
    ghToken: parsed.GH_TOKEN,
    ghOwner: parsed.GH_OWNER,
    coolifyUrl: parsed.COOLIFY_URL,
    coolifyToken: parsed.COOLIFY_TOKEN,
    coolifyServerUuid: parsed.COOLIFY_SERVER_UUID,
    coolifyProjectUuid: parsed.COOLIFY_PROJECT_UUID,
    coolifyGithubAppUuid: parsed.COOLIFY_GITHUB_APP_UUID,
  };
}

/**
 * Parse a "<providerID>/<modelID>" string into the structured form expected
 * by opencode. Returns undefined if the input doesn't match the expected
 * shape (callers should treat that as "use server default").
 *
 * Splits on the FIRST "/" so multi-segment model IDs like
 * "openrouter/anthropic/claude-sonnet-4-5" parse as
 * { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4-5" }.
 */
export function parseModelId(
  raw: string,
): { providerID: string; modelID: string } | undefined {
  const idx = raw.indexOf("/");
  if (idx <= 0 || idx === raw.length - 1) return undefined;
  return { providerID: raw.slice(0, idx), modelID: raw.slice(idx + 1) };
}
