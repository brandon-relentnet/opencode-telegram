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
});

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  workspaceRoot: string;
  logLevel: LogLevel;
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
  };
}
