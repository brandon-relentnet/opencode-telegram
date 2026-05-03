import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError, parseModelId } from "../src/config.js";

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
    expect(cfg.defaultModel).toBe("anthropic/claude-sonnet-4-5");
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
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "yelling" })).toThrow(/LOG_LEVEL/);
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

  it("rejects an invalid OPENCODE_URL", () => {
    expect(() => loadConfig({ ...validEnv, OPENCODE_URL: "not a url" })).toThrow(ConfigError);
  });

  it("trims whitespace and BOM-free padding on scalar env vars", () => {
    const cfg = loadConfig({
      ...validEnv,
      TELEGRAM_BOT_TOKEN: "  123:abc  ",
      OPENCODE_PASSWORD: "\tsecret\n",
    });
    expect(cfg.telegramBotToken).toBe("123:abc");
    expect(cfg.opencodePassword).toBe("secret");
  });

  it("accepts a custom DEFAULT_MODEL", () => {
    const cfg = loadConfig({ ...validEnv, DEFAULT_MODEL: "anthropic/claude-opus-4-5" });
    expect(cfg.defaultModel).toBe("anthropic/claude-opus-4-5");
  });

  it("accepts a multi-segment DEFAULT_MODEL like openrouter/anthropic/claude-sonnet-4-5", () => {
    const cfg = loadConfig({
      ...validEnv,
      DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4-5",
    });
    expect(cfg.defaultModel).toBe("openrouter/anthropic/claude-sonnet-4-5");
  });

  it("rejects a DEFAULT_MODEL without a slash", () => {
    expect(() => loadConfig({ ...validEnv, DEFAULT_MODEL: "anthropic" })).toThrow(/DEFAULT_MODEL/);
  });

  it("trims whitespace on DEFAULT_MODEL", () => {
    const cfg = loadConfig({ ...validEnv, DEFAULT_MODEL: "  openai/gpt-5  " });
    expect(cfg.defaultModel).toBe("openai/gpt-5");
  });
});

describe("parseModelId", () => {
  it("parses a simple providerID/modelID", () => {
    expect(parseModelId("anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  it("splits on the FIRST slash for multi-segment models", () => {
    expect(parseModelId("openrouter/anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4-5",
    });
  });

  it("returns undefined for input with no slash", () => {
    expect(parseModelId("just-a-name")).toBeUndefined();
  });

  it("returns undefined for input ending with a slash", () => {
    expect(parseModelId("anthropic/")).toBeUndefined();
  });

  it("returns undefined for input starting with a slash", () => {
    expect(parseModelId("/foo")).toBeUndefined();
  });
});
