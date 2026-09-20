import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { orderLoginCandidates, runLoginFailover, loginError, platformLoginError, waitForLoginTask } = require("../electron/login-failover.cjs");

afterEach(() => vi.useRealTimers());

describe("automatic login failover", () => {
  it("uses only reachable nodes in ascending measured latency order", () => {
    expect(orderLoginCandidates([
      { origin: "https://slow.example", online: true, latency: 420 },
      { origin: "https://offline.example", online: false, latency: 5 },
      { origin: "https://fast.example", online: true, latency: 35 }
    ])).toEqual([
      { origin: "https://fast.example", latency: 35 },
      { origin: "https://slow.example", latency: 420 }
    ]);
  });

  it("deduplicates redirected nodes and keeps their fastest measurement", () => {
    expect(orderLoginCandidates([
      { origin: "https://alias.example", finalOrigin: "https://node.example", online: true, latency: 90 },
      { origin: "https://node.example", online: true, latency: 60 },
      { origin: "", online: true, latency: 1 }
    ])).toEqual([{ origin: "https://node.example", latency: 60 }]);
  });

  it("prioritizes the selected node without treating unmeasured nodes as zero latency", () => {
    const result = orderLoginCandidates([
      { origin: "https://pending.example", online: null, latency: null },
      { origin: "https://fast.example", online: true, latency: 40 },
      { origin: "https://selected.example", online: false, latency: null }
    ], { includeUnmeasured: true, preferredOrigin: "https://selected.example" });
    expect(result.map((item: any) => item.origin)).toEqual(["https://selected.example", "https://fast.example", "https://pending.example"]);
  });

  it("rotates a stalled node and accepts the next without a terminal timeout", async () => {
    vi.useFakeTimers();
    let stalledSignal: AbortSignal | undefined;
    const attempt = vi.fn((candidate: any, signal: AbortSignal) => {
      if (candidate.origin === "slow") { stalledSignal = signal; return new Promise(() => {}); }
      return Promise.resolve(true);
    });
    const result = runLoginFailover({
      signal: new AbortController().signal, getCandidates: async () => [{ origin: "slow" }, { origin: "fast" }],
      attempt, nodeWaitMs: () => 100
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(stalledSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps checking after exhausted nodes and recovers in a later round", async () => {
    vi.useFakeTimers();
    const getCandidates = vi.fn(async (round: number) => round < 2 ? [] : [{ origin: "recovered" }]);
    const result = runLoginFailover({
      signal: new AbortController().signal, getCandidates, attempt: async () => true, retryDelayMs: () => 100
    });
    await vi.advanceTimersByTimeAsync(201);
    expect(await result).toBe(true);
    expect(getCandidates).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["discovery", "node", "retry-delay"])("cancels promptly during %s", async phase => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempt = vi.fn(async () => new Promise(() => {}));
    const result = runLoginFailover({
      signal: controller.signal,
      getCandidates: async () => phase === "discovery" ? new Promise(() => {}) : phase === "node" ? [{ origin: "node" }] : [],
      attempt, retryDelayMs: () => 1000, nodeWaitMs: () => 1000
    });
    const cancelled = expect(result).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(loginError("LOGIN_CANCELLED", "登录已取消"));
    await cancelled;
    await vi.advanceTimersByTimeAsync(10000);
    expect(attempt).toHaveBeenCalledTimes(phase === "node" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["密码错误", "登录过于频繁，请稍后重试", "Invalid credentials", "请输入验证码"])("stops submitting for an explicit rejection: %s", async message => {
    const attempt = vi.fn(async () => { throw platformLoginError(message); });
    await expect(runLoginFailover({
      signal: new AbortController().signal, getCandidates: async () => [{ origin: "one" }, { origin: "two" }], attempt
    })).rejects.toMatchObject({ code: "LOGIN_REJECTED" });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("ignores a late success after cancellation", async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    const task = waitForLoginTask(new Promise(done => { resolve = done; }), controller.signal);
    const cancelled = expect(task).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
    controller.abort(loginError("LOGIN_CANCELLED", "登录已取消"));
    resolve(true);
    await cancelled;
  });
});
