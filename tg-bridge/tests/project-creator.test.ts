import { describe, it, expect } from "vitest";
import { buildClonePrompt, buildInitPrompt, detectSuccess } from "../src/project-creator.js";

describe("buildClonePrompt", () => {
  it("substitutes URL and NAME into the template with StrictHostKeyChecking=accept-new", () => {
    const out = buildClonePrompt("git@github.com:foo/bar.git", "bar");
    expect(out).toContain("git clone -o StrictHostKeyChecking=accept-new git@github.com:foo/bar.git /workspace/bar");
    expect(out).toContain("reply with the single word: cloned");
    expect(out).toContain("failed:");
    expect(out).toContain("Do not run any other commands");
  });

  it("works with HTTPS URLs", () => {
    const out = buildClonePrompt("https://github.com/foo/bar.git", "myproject");
    expect(out).toContain("git clone -o StrictHostKeyChecking=accept-new https://github.com/foo/bar.git /workspace/myproject");
  });
});

describe("buildInitPrompt", () => {
  it("substitutes NAME into the mkdir + git init template", () => {
    const out = buildInitPrompt("myproject");
    expect(out).toContain("mkdir -p /workspace/myproject && git init /workspace/myproject");
    expect(out).toContain("reply with the single word: initialized");
    expect(out).toContain("failed:");
    expect(out).toContain("Do not create README files");
  });
});

describe("detectSuccess", () => {
  it("returns true for clone success when text starts with 'cloned'", () => {
    const parts = [{ id: "p1", type: "text", text: "cloned" }];
    expect(detectSuccess(parts, "clone")).toBe(true);
  });

  it("returns true for init success when text starts with 'initialized'", () => {
    const parts = [{ id: "p1", type: "text", text: "initialized" }];
    expect(detectSuccess(parts, "init")).toBe(true);
  });

  it("is case-insensitive on the success marker", () => {
    expect(detectSuccess([{ id: "p1", type: "text", text: "Cloned" }], "clone")).toBe(true);
    expect(detectSuccess([{ id: "p1", type: "text", text: "INITIALIZED" }], "init")).toBe(true);
  });

  it("matches when success marker is followed by extra text", () => {
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "cloned successfully" }], "clone"),
    ).toBe(true);
  });

  it("does not match partial-prefix words (uses word boundary)", () => {
    // "clonedown" should NOT match "cloned\b"
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "clonedown" }], "clone"),
    ).toBe(false);
  });

  it("does not match the wrong-kind marker", () => {
    expect(detectSuccess([{ id: "p1", type: "text", text: "initialized" }], "clone")).toBe(false);
    expect(detectSuccess([{ id: "p1", type: "text", text: "cloned" }], "init")).toBe(false);
  });

  it("returns false for an explicit failure response", () => {
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "failed: auth error" }], "clone"),
    ).toBe(false);
  });

  it("returns false for empty parts", () => {
    expect(detectSuccess([], "clone")).toBe(false);
  });

  it("ignores tool parts and concatenates only text parts in order", () => {
    const parts = [
      { id: "t1", type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } },
      { id: "p1", type: "text", text: "cloned" },
    ];
    expect(detectSuccess(parts, "clone")).toBe(true);
  });

  it("uses the first text part for marker detection (so trailing chatter is OK)", () => {
    // Concatenated text starts with 'cloned' → matches
    const parts = [
      { id: "p1", type: "text", text: "cloned" },
      { id: "p2", type: "text", text: "and the directory now exists" },
    ];
    expect(detectSuccess(parts, "clone")).toBe(true);
  });

  it("returns false when text does not start with the marker", () => {
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "I cloned the repo" }], "clone"),
    ).toBe(false);
  });
});
