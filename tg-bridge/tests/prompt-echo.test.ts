import { describe, it, expect } from "vitest";
import { isPromptEcho } from "../src/prompt-echo.js";

describe("isPromptEcho", () => {
  it("returns false when prompt is empty/null/undefined", () => {
    expect(isPromptEcho("anything", "")).toBe(false);
    expect(isPromptEcho("anything", null)).toBe(false);
    expect(isPromptEcho("anything", undefined)).toBe(false);
  });

  it("returns false when prompt is too short for reliable matching", () => {
    expect(isPromptEcho("hi there friend", "hi")).toBe(false);
  });

  it("detects verbatim echo", () => {
    expect(
      isPromptEcho(
        "fix the navbar mobile responsive",
        "fix the navbar mobile responsive",
      ),
    ).toBe(true);
  });

  it("detects verbatim echo with surrounding agent prose", () => {
    expect(
      isPromptEcho(
        "fix the navbar mobile responsive",
        "fix the navbar mobile responsive",
      ),
    ).toBe(true);
  });

  it("detects close paraphrase via Jaccard similarity", () => {
    // Same words, different order — Jaccard sees them as identical sets.
    expect(
      isPromptEcho(
        "the navbar mobile responsive fix",
        "fix the navbar mobile responsive",
      ),
    ).toBe(true);
  });

  it("does NOT echo-flag when assistant adds substantial new content", () => {
    expect(
      isPromptEcho(
        "I will fix the navbar mobile responsive issue by editing src/components/Navbar.tsx and adding the proper breakpoint classes for sm and md viewports along with refactoring the menu toggle.",
        "fix the navbar mobile responsive",
      ),
    ).toBe(false);
  });

  it("normalizes whitespace + case", () => {
    expect(
      isPromptEcho(
        "  Fix The   Navbar Mobile Responsive  ",
        "fix the navbar mobile responsive",
      ),
    ).toBe(true);
  });

  it("returns false for unrelated content", () => {
    expect(
      isPromptEcho(
        "The bug is at line 42 of config.ts",
        "fix the navbar mobile responsive",
      ),
    ).toBe(false);
  });
});
