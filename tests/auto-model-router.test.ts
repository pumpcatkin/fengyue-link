import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { normalizeCatalog, rankModels, runAutoModel, retryable, retryDelay } = require("../electron/auto-model-router.cjs");
const record = (model: string, price = "1", success = 90, extra = {}) => ({ provider_name: "provider", model_id: model, model_price: price, success_rate: success, average_latency: 2000, ...extra });
const catalog = (...records: any[]) => normalizeCatalog({ data: { models: records } });

describe("automatic model routing", () => {
  it("prioritizes DS v4 and GLM 5.3 Flash, then Gemini 3.5+ Flash", () => {
    const ranked = rankModels(catalog(record("gemini-3.1-flash", ".001"), record("deepseek-v4-pro", ".001"),
      record("gemini-4-flash", ".5"), record("Gemini-3.5-flash"), record("GLM-5.3-Flash"), record("deepseek-v4.1-flash", ".5")));
    expect(ranked.map((item: any) => item.model)).toEqual(["deepseek-v4.1-flash", "GLM-5.3-Flash", "gemini-4-flash", "Gemini-3.5-flash", "deepseek-v4-pro", "gemini-3.1-flash"]);
    expect(catalog(record("deepseek-v40-flash"), record("glm-5.30-flash"))[0].priority).toBe(2);
    expect(catalog(record("glm-5.30-flash"))[0].priority).toBe(2);
  });
  it("uses success percent per price, then latency; preserves zero and missing metadata", () => {
    const ranked = rankModels(catalog(record("slow", "2", 90), record("fast", "1", 50), record("faster", "1", 50, { average_latency: 100 }),
      record("unknown", "", 99), record("zero-success", ".001", 0), record("free", "0", 90), record("tiny-success", "1", .5)));
    expect(ranked.map((item: any) => item.model)).toEqual(["free", "faster", "fast", "slow", "tiny-success", "zero-success", "unknown"]);
    expect(ranked.find((item: any) => item.model === "tiny-success").successRate).toBe(.5);
    expect(catalog(record("one", "1", 90, { support_streaming: false }), record("two", "1", 90, { status: "offline" }),
      record("three", "1", 90, { modalities: { output: { text: { supported: false } } } }))).toEqual([]);
  });
  it("keeps switching beyond three attempts, refreshes exhausted catalogs, and stops at valid output", async () => {
    const models = catalog(record("deepseek-v4-flash"), record("gemini-3.5-flash"));
    const loadModels = vi.fn(async () => models);
    const used: string[] = [];
    const execute = vi.fn(async ({ model, attempt }: any) => { used.push(model.model); if (attempt < 7) throw new Error("invalid JSON"); return "done"; });
    const wait = vi.fn(async () => {});
    expect(await runAutoModel({ loadModels, execute, wait })).toBe("done");
    expect(used).toEqual([models[0].model, models[1].model, models[0].model, models[1].model, models[0].model, models[1].model, models[0].model]);
    expect(loadModels).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.length).toBe(6);
  });
  it("cancels during backoff and never sends another request", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => { throw new Error("network"); });
    await expect(runAutoModel({ signal: controller.signal, loadModels: async () => catalog(record("deepseek-v4-flash")), execute,
      onState: ({ stage }: any) => { if (stage === "waiting") controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not accept late output after cancellation and stops on insufficient points", async () => {
    const controller = new AbortController();
    await expect(runAutoModel({ signal: controller.signal, loadModels: async () => catalog(record("m")), execute: async () => { controller.abort(); return "late"; } })).rejects.toMatchObject({ name: "AbortError" });
    const wait = vi.fn();
    await expect(runAutoModel({ loadModels: async () => catalog(record("m")), execute: async () => { throw new Error("积分不足"); }, wait })).rejects.toThrow("积分不足");
    expect(wait).not.toHaveBeenCalled();
    expect(retryable(Object.assign(new Error("401"), { retryable: false }))).toBe(false);
  });
  it("backs off an empty catalog and admits models returned later", async () => {
    const loadModels = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(catalog(record("new")));
    const execute = vi.fn(async () => "ok");
    await expect(runAutoModel({ loadModels, execute, wait: async () => {} })).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("honors a model endpoint Retry-After without sharing the comment FIFO", async () => {
    expect(retryDelay(1000, { retryAfterMs: 45_000 })).toBe(45_000);
    expect(retryDelay(2000, { retryAfterMs: 500 })).toBe(2000);
    expect(retryDelay(1000, { retryAfterMs: 60 * 60 * 1000 })).toBe(10 * 60 * 1000);
    const waits: number[] = [];
    let attempts = 0;
    await expect(runAutoModel({
      loadModels: async () => catalog(record("deepseek-v4-flash")),
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("请求过于频繁，请稍后"), { retryAfterMs: 45_000 });
        return "ok";
      },
      wait: async (ms: number) => { waits.push(ms); }
    })).resolves.toBe("ok");
    expect(waits).toContain(45_000);
  });
});

describe("desktop model router integration", () => {
  function backend() {
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const router = require("../electron/auto-model-router.cjs");
    const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
      ...router, crypto: require("node:crypto"), AbortController, setInterval, clearInterval,
      runAutoModel: (options: any) => router.runAutoModel({ ...options, wait: async () => {} })
    });
    const instance = Object.create(Backend.prototype);
    Object.assign(instance, { loggedIn: true, authSessionRevision: 1, autoModelJobs: new Map(), autoModelQueues: new Map(), emit: vi.fn(), appendSessionLog: vi.fn(), account: {}, work: { id: "work" } });
    let config: any = { model: { provider: "old", name: "old", completion_params: { temperature: .7, max_token: 4096 } }, world_book: [{ key: "preserved" }], pre_prompt: "original" };
    instance.platformGoApi = vi.fn(async (endpoint: string, options: any = {}) => {
      if (endpoint.includes("model-list")) return { data: { models: [record("deepseek-v4-flash"), record("gemini-3.5-flash")] } };
      if (options.method === "POST") config = { ...config, ...options.body };
      return { data: config };
    });
    return instance;
  }
  it("verifies the actual model, scopes writes to model fields, and releases jobs after success", async () => {
    const instance = backend();
    const seen: string[] = [];
    const result = await instance.withAutoModel("work", "测试", async ({ model, attempt }: any) => { seen.push(model.model); if (attempt < 5) throw new Error("empty output"); return "ok"; }, { conversationId: "session" });
    expect(result).toBe("ok");
    expect(seen).toHaveLength(5);
    expect(instance.autoModelJobs.size).toBe(0);
    expect(instance.autoModelQueues.size).toBe(0);
    for (const [_url, options] of instance.platformGoApi.mock.calls.filter((call: any) => call[1]?.method === "POST")) {
      expect(Object.keys(options.body).every(key => ["app_id", "conversation_id", "model"].includes(key))).toBe(true);
    }
  });
  it("serializes model config and generation for concurrent requests to the same work", async () => {
    const instance = backend();
    const events: string[] = [];
    let release: any;
    const pending = new Promise(resolve => { release = resolve; });
    const first = instance.withAutoModel("work", "first", async () => { events.push("first"); await pending; return 1; });
    const second = instance.withAutoModel("work", "second", async () => { events.push("second"); return 2; });
    await vi.waitFor(() => expect(events).toEqual(["first"]));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first", "second"]);
  });
  it("cancels requests when the auth context changes, without accepting stale output", async () => {
    const instance = backend();
    await expect(instance.withAutoModel("work", "stale", async () => { instance.authSessionRevision++; return "old account output"; })).rejects.toMatchObject({ name: "AbortError" });
    expect(instance.autoModelJobs.size).toBe(0);
  });
  it("bounds structured validation retries and always removes previous conversation identifiers", async () => {
    const instance = backend();
    const { OnlineWorldService } = require("../electron/online-world-service.cjs");
    const service = new OnlineWorldService({
      requestModel: vi.fn(async (request: any) => {
        expect(request.conversation_id).toBeUndefined();
        expect(request.conversationId).toBeUndefined();
        count++;
        return { conversationId: `fresh-${count}`, answer: count < 6 ? "bad json" : '{"ok":true}' };
      }),
      runModelTask: (label: string, run: any) => instance.withAutoModel("work", label, run),
      getAccount: () => ({}), onChange: () => {}
    });
    let count = 0;
    await expect(service.requestStructuredModel({ task: "test", conversation_id: "old", conversationId: "old" }, { attempts: 3, validate: (data: any) => data.ok ? null : "not ready" })).rejects.toThrow(/未返回有效结构化结果/);
    expect(count).toBe(3);
    expect(service.modelUsageEvents).toHaveLength(3);
  });
  it("counts actual structured requests independently from outer model selection attempts", async () => {
    const { OnlineWorldService } = require("../electron/online-world-service.cjs");
    let generated = 0;
    const service = new OnlineWorldService({
      requestModel: async () => ({
        conversationId: `actual-${++generated}`,
        answer: generated < 3 ? "bad json" : '{"ok":true}'
      }),
      runModelTask: async (_label: string, execute: any) => {
        let lastError: any;
        for (const attempt of [141, 142, 143]) {
          try { return await execute({ attempt }); }
          catch (error) { lastError = error; }
        }
        throw lastError;
      },
      getAccount: () => ({}), onChange: () => {}
    });
    await expect(service.requestStructuredModel({ task: "test" }, { attempts: 3, validate: (data: any) => data.ok ? null : "not ready" })).resolves.toEqual({ ok: true });
    expect(generated).toBe(3);
    expect(service.modelUsageEvents.map((item: any) => item.attempt)).toEqual([1, 2, 3]);
  });
});
