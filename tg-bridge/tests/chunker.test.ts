import { describe, it, expect } from "vitest";
import { chunkForTelegram, MAX_TELEGRAM_LENGTH } from "../src/chunker.js";

describe("chunkForTelegram", () => {
  it("returns a single chunk when input is short", () => {
    expect(chunkForTelegram("hello")).toEqual(["hello"]);
  });

  it("returns a single chunk when input is exactly at the safe max", () => {
    const text = "a".repeat(MAX_TELEGRAM_LENGTH);
    expect(chunkForTelegram(text)).toEqual([text]);
  });

  it("splits long text at paragraph boundaries", () => {
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const para3 = "c".repeat(2000);
    const input = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
    expect(chunks.join("")).toContain(para1);
    expect(chunks.join("")).toContain(para2);
    expect(chunks.join("")).toContain(para3);
  });

  it("keeps a small code block intact in one chunk", () => {
    const input = "before\n\n```ts\nconst x = 1;\n```\n\nafter";
    expect(chunkForTelegram(input)).toEqual([input]);
  });

  it("splits a code block that exceeds the safe max, closing and reopening with the same language", () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `line ${i};`);
    const input = "intro\n\n```ts\n" + codeLines.join("\n") + "\n```\n\noutro";
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
      // every chunk must have balanced fences
      const fenceCount = (c.match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    // language hint is preserved on the re-opened fence
    const middleChunks = chunks.slice(1);
    expect(middleChunks.every((c) => c.startsWith("```ts"))).toBe(true);
  });

  it("hard-splits a single very long line as a last resort", () => {
    const input = "x".repeat(MAX_TELEGRAM_LENGTH * 2 + 500);
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
    expect(chunks.join("")).toBe(input);
  });

  it("handles empty input", () => {
    expect(chunkForTelegram("")).toEqual([]);
  });

  it("handles a code block with no language hint", () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `L${i}`);
    const input = "```\n" + codeLines.join("\n") + "\n```";
    const chunks = chunkForTelegram(input);
    for (const c of chunks) {
      const fenceCount = (c.match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });
});
