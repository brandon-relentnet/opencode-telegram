import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

describe("loadConfig", () => {
  const validEnv = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_USER_IDS: "111,222",
    OPENCODE_PASSWORD: "secret",
  };

  it("parses a valid env with defaults", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.telegramBotToken).toBe("123:abc");
    expect(cfg.allowedUserIds).toEqual([111, 222]);
    expect(cfg.opencodeUrl).toBe("http://opencode:4096");
    expect(cfg.opencodeUsername).toBe("opencode");
    expect(cfg.opencodePassword).toBe("secret");
    expect(cfg.workspaceRoot).toBe("/workspace");
    expect(cfg.logLevel).toBe("info");
  });

  it("trims whitespace and ignores empty entries in user IDs", () => {
    const cfg = loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: " 111 , , 222 " });
    expect(cfg.allowedUserIds).toEqual([111, 222]);
  });

  it("rejects non-numeric user IDs", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: "111,abc" })).toThrow(
      ConfigError,
    );
  });

  it("rejects empty allowlist", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: "" })).toThrow(ConfigError);
  });

  it("requires TELEGRAM_BOT_TOKEN", () => {
    const env = { ...validEnv } as Record<string, string>;
    delete env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig(env)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("requires OPENCODE_PASSWORD", () => {
    const env = { ...validEnv } as Record<string, string>;
    delete env.OPENCODE_PASSWORD;
    expect(() => loadConfig(env)).toThrow(/OPENCODE_PASSWORD/);
  });

  it("rejects unknown log level", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "yelling" })).toThrow(ConfigError);
  });

  it("accepts custom OPENCODE_URL and WORKSPACE_ROOT", () => {
    const cfg = loadConfig({
      ...validEnv,
      OPENCODE_URL: "http://example.local:9000",
      WORKSPACE_ROOT: "/data/code",
    });
    expect(cfg.opencodeUrl).toBe("http://example.local:9000");
    expect(cfg.workspaceRoot).toBe("/data/code");
  });
});
