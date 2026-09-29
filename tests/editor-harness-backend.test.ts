import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createBlankEditorProject } = require("../electron/online-game-editor.cjs");
const { runAutoModel } = require("../electron/auto-model-router.cjs");
const models = [{ model: "gpt-5.6", label: "GPT", provider: "a" }, { model: "claude-opus-4-6", label: "Claude", provider: "b" }, { model: "glm-5.3", label: "GLM", provider: "c" }];

function setup(request: any) {
  const source = readFileSync(new URL("../electron/editor-harness-backend.cjs", import.meta.url), "utf8");
  const module = { exports: {} as any };
  const save = vi.fn();
  vm.runInNewContext(source, { module, console, AbortController, Date, require: (id: string) => {
    if (id === "node:fs") return { existsSync: () => true };
    if (id === "./runtime-utils.cjs") return { atomicWriteJsonSync: vi.fn(), readJsonWithBackupSync: () => ({ value: { "https://example.org|owner": { ready: true, version: 2, workId: "work" } } }) };
    if (id === "./online-game-editor.cjs") return { saveEditorProjects: save };
    if (id === "./game-harness-browser.cjs") return { testGameInBrowser: async () => ({ passed: true }) };
    return require(id.startsWith("./") ? `../electron/${id.slice(2)}` : id);
  } });
  const project = createBlankEditorProject({ origin: "https://example.org", accountId: "owner" });
  const backend: any = { account: { accountId: "owner" }, origin: "https://example.org", onlineWorldEditorFile: "fixture.json", onlineWorldEditorProjects: { projects: { draft: project } },
    onlineWorldEditorProject: () => backend.onlineWorldEditorProjects.projects.draft, assertToolLoggedIn: vi.fn(), emit: vi.fn(), cancelAutoModels: vi.fn(), appendSessionLog: vi.fn(),
    requestEditorModelForWork: request,
    normalizeModelPayload: (value: any) => value, platformGoApi: async () => ({ model: { name: "gpt-5.6", provider: "a" } }),
    platformChatApi: vi.fn(async () => ({})), onlineWorldService: { readBackModelConfig: vi.fn(async () => ({})) },
    withAutoModel: (_id: any, _label: any, execute: any, options: any) => runAutoModel({ loadModels: async () => models, execute, ...options, wait: async () => {}, signal: new AbortController().signal }) };
  return { backend, run: module.exports.runEditorHarness, save };
}

describe("harness billing integration", () => {
  it("charges malformed replies and fallback attempts, then pauses before a further call", async () => {
    const request = vi.fn().mockResolvedValueOnce({ answer: "bad json", points: { total: 60000 } })
      .mockResolvedValueOnce({ answer: JSON.stringify({ tool: "read_file", args: { path: "configuration.json" } }), points: { total: 30000 } });
    const { backend, run } = setup(request);
    await expect(run(backend, { libraryId: "draft", goal: "test", budgetPoints: 80000 })).rejects.toMatchObject({ code: "HARNESS_BUDGET_EXHAUSTED" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(backend.onlineWorldEditorJob).toMatchObject({ status: "paused", budget: { spent: 90000, requests: 2 } });
    expect(backend.onlineWorldEditorProjects.projects.draft.harnessCandidate.budget.spent).toBe(90000);
    expect(backend.onlineWorldEditorSessionKey).toBeNull();
  });
  it("counts billed request failures and does not retry past the limit", async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("connection closed"), { modelUsage: { points: { total: 80000 } } }));
    const { backend, run } = setup(request);
    await expect(run(backend, { libraryId: "draft", goal: "test" })).rejects.toMatchObject({ code: "HARNESS_BUDGET_EXHAUSTED" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(backend.onlineWorldEditorJob.budget.spent).toBe(80000);
  });
  it("pauses on unknown billing even in unlimited mode, rather than inventing zero", async () => {
    const request = vi.fn().mockResolvedValue({ answer: "{}", points: { total: null } });
    const { backend, run } = setup(request);
    await expect(run(backend, { libraryId: "draft", goal: "test", budgetPoints: null })).rejects.toMatchObject({ code: "HARNESS_BILLING_UNKNOWN" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(backend.onlineWorldEditorJob.budget).toMatchObject({ limit: null, unknownCharges: 1 });
  });
  it("validates the budget before any paid request", async () => {
    const request = vi.fn();
    const { backend, run } = setup(request);
    await expect(run(backend, { libraryId: "draft", goal: "test", budgetPoints: 79999 })).rejects.toThrow("80000");
    expect(request).not.toHaveBeenCalled();
  });
});
