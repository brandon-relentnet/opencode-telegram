import { describe, it, expect, vi } from "vitest";
import { buildAuthFetch } from "../src/opencode-client.js";

describe("buildAuthFetch", () => {
  it("adds an Authorization: Basic header with base64-encoded user:pass", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "opencode", "secret");

    await wrapped("http://opencode:4096/global/health");

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const init = (call[1] ?? {}) as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(
      "Basic " + Buffer.from("opencode:secret").toString("base64"),
    );
  });

  it("preserves existing headers and body", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    await wrapped("http://opencode:4096/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const init = (call[1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toMatch(/^Basic /);
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("works when init is undefined", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    await wrapped("http://opencode:4096/x");

    expect(inner).toHaveBeenCalledOnce();
    const init = ((inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] ?? {}) as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toMatch(/^Basic /);
  });

  it("preserves Content-Type and body when input is a fully-built Request (the SDK case)", async () => {
    // Regression: Node 22's fetch, when given (request, init={headers}),
    // REPLACES the request's headers with init.headers — so a naive impl
    // would drop Content-Type: application/json on requests built by the
    // SDK and opencode would then reject the body as "expected array,
    // received undefined at parts".
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    const original = new Request("http://opencode:4096/session/abc/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "preserved" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    await wrapped(original);

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sentRequest = call[0] as Request;
    expect(sentRequest).toBeInstanceOf(Request);
    expect(sentRequest.headers.get("Content-Type")).toBe("application/json");
    expect(sentRequest.headers.get("X-Custom")).toBe("preserved");
    expect(sentRequest.headers.get("Authorization")).toMatch(/^Basic /);
    expect(sentRequest.method).toBe("POST");
    expect(await sentRequest.text()).toBe(
      JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    );
  });
});
