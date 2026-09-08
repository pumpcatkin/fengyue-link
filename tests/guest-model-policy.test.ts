import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const policy = require("../electron/guest-model-policy.cjs");
const conversationId = "a5b2fe20-78c0-447e-a13c-8ecb27d13e44";
const model = (name: string, price: unknown, rate: unknown, family = "grok") => ({ provider: "sticky_grok", model: name, label: name, family, priceCoefficient: price, successRate: rate });
const candidates = [model("costly", "8", 1), model("quick", "0.1", 98), model("slow", "0.1", 2), model("gpt", "0", 0, "gpt")];

function backend({ activeId = conversationId, role = "guest" } = {}) {
  const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
    ...policy, URL, URLSearchParams, Buffer, console, clearTimeout,
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
    parseInviteWork: (suffix: string) => ({ id: suffix })
  });
  const instance = Object.create(Backend.prototype);
  const server: any = {
    app: { pre_prompt: "global prompt", is_global: true, model: { provider: "sticky_grok", name: "costly", completion_params: { temperature: 0.35, max_tokens: 800 } } },
    conversation: { pre_text: "local prefix", is_global: false, sent_message_count: 9, model: { provider: "sticky_grok", name: "quick", completion_params: { temperature: 0.45 } } },
    discardWrites: false
  };
  Object.assign(instance, {
    loggedIn: true, work: { suffix: "app", url: "https://example.invalid/work" }, origin: "https://example.invalid",
    room: { id: "r", role, model: { provider: "host", model: "real-story" } },
    conversation: { activeId, sessionKey: "anchor" },
    platformModels: { items: [], selected: null },
    emit: vi.fn(), appendSessionLog: vi.fn(), gameSurface: {},
    workGameUrl: () => "https://example.invalid/work/game",
    loadSurfaceUrl: vi.fn(async () => true), ensureGameSurfaceMounted: vi.fn(async () => ({ mounted: true })), applyGameIsolation: vi.fn(async () => true),
    normalizeModelPayload: (value: unknown) => value,
    platformGoApi: vi.fn(async (url: string, options: any = {}) => {
      if (url === "/workspaces/model-list") return { models: candidates.map(item => ({ provider_name: item.provider, model_id: item.model, model_price: item.priceCoefficient, success_rate: item.successRate })) };
      const scope = options.body?.conversation_id || new URL(url, "https://example.invalid").searchParams.get("conversation_id") ? "conversation" : "app";
      if (options.method === "POST" && !server.discardWrites) server[scope] = { ...server[scope], model: structuredClone(options.body.model) };
      return structuredClone(server[scope]);
    })
  });
  return { instance, server, writes: () => instance.platformGoApi.mock.calls.filter((call: any[]) => call[1]?.method === "POST") };
}

describe("guest tested model ranking", () => {
  it("prefers the measured Grok model when it is actually in the current list", () => {
    const measured = { ...model("grok-4.5", 0.075, 87), provider: "sticky_grok" };
    expect(policy.selectGuestModel([model("cheaper-grok", 0.01, 99), measured])).toBe(measured);
    expect(policy.selectGuestModel([model("cheaper-grok", 0.01, 99)]).model).toBe("cheaper-grok");
  });
  it("falls back only to an available measured model if the Grok family is absent", () => {
    const fallback = { ...model("glm-5.3-flash", 0.046, 42, "other"), provider: "dian_glm" };
    expect(policy.selectGuestModel([fallback])).toBe(fallback);
    expect(() => policy.selectGuestModel([{ ...fallback, model: "unmeasured-model" }])).toThrow("实测型号");
  });
  it("selects lowest price, breaking price ties by lowest output rate, and excludes other families", () => {
    expect(policy.selectGuestModel(candidates).model).toBe("slow");
    expect(policy.selectGuestModel([...candidates, model("free", 0, 80)]).model).toBe("free");
    expect(policy.selectGuestModel([...candidates].reverse()).model).toBe("slow");
  });
  it("does not mistake missing price/rate for free or zero output", () => {
    for (const value of [undefined, null, "", " ", false, NaN, Infinity, -1, "free?", "1-2"]) expect(policy.modelMetric(value)).toBeNull();
    expect(policy.modelMetric("×0.15")).toBe(0.15);
    expect(policy.modelMetric("2%", { percent: true })).toBe(2);
    expect(policy.selectGuestModel([model("unknown-price", null, 0), model("unknown-rate", 0.1, null), candidates[2]]).model).toBe("slow");
    expect(() => policy.selectGuestModel([model("unknown", null, 0), candidates[3]])).toThrow("Grok");
  });
  it("uses deterministic identifiers for identical metrics", () => {
    expect(policy.selectGuestModel([model("b", 0.1, 1), model("a", 0.1, 1)]).model).toBe("a");
  });
});

describe("persisted guest model enforcement", () => {
  it("replaces a valid expensive model and a saved conversation override while preserving all unrelated settings", async () => {
    const { instance, server, writes } = backend();
    const selected = await instance.ensureValidPlatformModelWithRetries(1);
    expect(selected.model).toBe("slow");
    expect(server.app).toMatchObject({ pre_prompt: "global prompt", is_global: true, model: { name: "slow", completion_params: { temperature: 0.35, max_tokens: 800 } } });
    expect(server.conversation).toMatchObject({ pre_text: "local prefix", is_global: false, sent_message_count: 9, model: { name: "slow", completion_params: { temperature: 0.45 } } });
    expect(writes().map((call: any[]) => Object.keys(call[1].body).sort())).toEqual([["app_id", "model"], ["app_id", "conversation_id", "model"]]);
    expect(instance.room.model.model).toBe("real-story");
    expect(instance.loadSurfaceUrl).toHaveBeenCalledOnce();
    expect(instance.conversation).toEqual({ activeId: conversationId, sessionKey: "anchor" });
    await instance.ensureValidPlatformModelWithRetries(1);
    expect(writes()).toHaveLength(2);
    expect(instance.loadSurfaceUrl).toHaveBeenCalledOnce();
  });
  it("sets the default before the first request without inventing a conversation ID", async () => {
    const { instance, writes } = backend({ activeId: "" });
    await instance.ensureValidPlatformModelWithRetries(1);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1].body).not.toHaveProperty("conversation_id");
  });
  it("does not change a host's valid selected model", async () => {
    const { instance, writes } = backend({ role: "host" });
    await instance.refreshPlatformModels({ ensureValid: true });
    expect(instance.platformModels.selected.model).toBe("costly");
    expect(writes()).toHaveLength(0);
  });
  it("blocks placeholder requests when the server reports success but does not persist changes", async () => {
    const { instance, server } = backend();
    server.discardWrites = true;
    instance.prepareGuestRoundInput = vi.fn();
    await expect(instance.prepareGuestRoundInputWithRetries({ round: 1, input: "query" })).rejects.toThrow("平台未保存");
    expect(instance.prepareGuestRoundInput).not.toHaveBeenCalled();
    expect(instance.loadSurfaceUrl).not.toHaveBeenCalled();
  });
  it("rejects stale selection after a failed refresh", async () => {
    const { instance } = backend();
    await instance.ensureValidPlatformModelWithRetries(1);
    instance.platformGoApi.mockRejectedValue(new Error("network offline"));
    await expect(instance.ensureValidPlatformModelWithRetries(1)).rejects.toThrow("network offline");
  });
  it("still reloads after a lost write response when the retry reads the already-saved model", async () => {
    const { instance, server } = backend({ activeId: "" });
    const api = instance.platformGoApi.getMockImplementation();
    let lost = false;
    instance.platformGoApi.mockImplementation(async (...args: any[]) => {
      const response = await api(...args);
      if (args[1]?.method === "POST" && !lost) { lost = true; throw new Error("lost response"); }
      return response;
    });
    await instance.ensureValidPlatformModelWithRetries(2);
    expect(server.app.model.name).toBe("slow");
    expect(instance.loadSurfaceUrl).toHaveBeenCalledOnce();
    expect(instance.guestModelReloadPending).toBe(false);
  });
  it("stops writes if the guest leaves during a config read", async () => {
    const { instance, writes } = backend();
    instance.platformModels.items = candidates;
    const api = instance.platformGoApi.getMockImplementation();
    instance.platformGoApi.mockImplementation(async (...args: any[]) => { const value = await api(...args); instance.room = null; return value; });
    await expect(instance.enforceGuestPlatformModel()).rejects.toThrow("房间或会话已变化");
    expect(writes()).toHaveLength(0);
  });
  it("verifies before native sending and does not reload between placeholder retries", async () => {
    const { instance } = backend();
    instance.prepareGuestRoundInput = vi.fn().mockRejectedValueOnce(new Error("DOM pending")).mockResolvedValue({ stopped: true });
    await instance.prepareGuestRoundInputWithRetries({ round: 1, input: "query" });
    expect(instance.loadSurfaceUrl).toHaveBeenCalledOnce();
    expect(instance.prepareGuestRoundInput).toHaveBeenCalledTimes(2);
    expect(instance.loadSurfaceUrl.mock.invocationCallOrder[0]).toBeLessThan(instance.prepareGuestRoundInput.mock.invocationCallOrder[0]);
  });
});
