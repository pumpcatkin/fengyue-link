import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { requestPlatformJson, isTransientPlatformError } = require("../electron/platform-transport.cjs");
const defaults = { origin: "https://node.test", pathname: "/go/api/account/profile", attempts: 1 };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
afterEach(() => vi.useRealTimers());

describe("account session transport", () => {
  it("preserves partition cookies, optional bearer authentication and the server timestamp", async () => {
    const fetch = vi.fn(async () => json({ code: 100000, data: { id: "account" } }, 200, { date: "Mon, 21 Sep 2026 01:00:00 GMT" }));
    const result = await requestPlatformJson({ ...defaults, fetch, token: "fixture" });
    expect(result).toEqual({ payload: { code: 100000, data: { id: "account" } }, serverTime: Date.parse("2026-09-21T01:00:00Z") });
    expect(fetch.mock.calls[0]).toEqual(["https://node.test/go/api/account/profile", expect.objectContaining({
      credentials: "include", redirect: "manual", headers: expect.objectContaining({ Authorization: "Bearer fixture", Origin: "https://node.test" })
    })]);
  });

  it("retries a temporary read failure once", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(json({ data: [] }));
    expect((await requestPlatformJson({ ...defaults, fetch, attempts: 2 })).payload).toEqual({ data: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never blindly repeats an uncertain write", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(requestPlatformJson({ ...defaults, fetch, method: "POST", body: { eventId: "same-event" }, attempts: 2 })).rejects.toMatchObject({ code: "PLATFORM_NETWORK" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts successful no-content deletion responses", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    expect((await requestPlatformJson({ ...defaults, fetch, method: "DELETE" })).payload).toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429, 302])("does not retry or follow HTTP %s", async status => {
    const fetch = vi.fn(async () => json({}, status, { "retry-after": "120", location: "https://other.test/login" }));
    await expect(requestPlatformJson({ ...defaults, fetch, attempts: 2 })).rejects.toMatchObject({ status, ...(status === 429 ? { retryAfterMs: 120000 } : {}) });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects business errors and HTML rather than turning them into an empty world", async () => {
    for (const response of [json({ code: 500123, message: { error: "internal" } }), new Response("<html>challenge</html>"), json(null)]) {
      const fetch = vi.fn(async () => response);
      await expect(requestPlatformJson({ ...defaults, fetch, attempts: 2 })).rejects.toThrow(/\[PLATFORM_(API|INVALID_JSON)\]/);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each(["headers", "body"])("bounds stalled %s even if the underlying request ignores cancellation", async stage => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => stage === "headers" ? new Promise(() => {}) : {
      ok: true, headers: new Headers(), json: () => new Promise(() => {})
    });
    const request = requestPlatformJson({ ...defaults, fetch, timeout: 100 });
    const result = expect(request).rejects.toMatchObject({ code: "PLATFORM_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(101);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels immediately and rejects cross-origin API addresses", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => new Promise(() => {}));
    const request = requestPlatformJson({ ...defaults, fetch, signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "PLATFORM_CANCELLED" });
    await expect(requestPlatformJson({ ...defaults, fetch, pathname: "https://other.test/go/api/profile" })).rejects.toMatchObject({ code: "PLATFORM_URL" });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(requestPlatformJson({ ...defaults, fetch, method: "POST", signal: controller.signal })).rejects.toMatchObject({ code: "PLATFORM_CANCELLED" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never interprets authentication or rate limiting as a transient retry", () => {
    for (const error of [new Error("401 network"), new Error("429 timeout"), { code: "PLATFORM_RATE_LIMIT", status: 429 }, { code: "PLATFORM_AUTH", status: 403 }]) {
      expect(isTransientPlatformError(error)).toBe(false);
    }
  });
});
