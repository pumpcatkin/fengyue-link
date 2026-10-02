import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createBlankEditorProject, createEditorProject, activeEditorSession, selectEditorSession, updateEditorSession, markEditorProjectPendingUpload } = require("../electron/online-game-editor.cjs");
const { createBundledGridCard } = require("../electron/online-world-card.cjs");
const { runAutoModel } = require("../electron/auto-model-router.cjs");
const models = [{ model: "gpt-5.6", label: "GPT", provider: "a" }, { model: "claude-opus-4-6", label: "Claude", provider: "b" }, { model: "glm-5.3", label: "GLM", provider: "c" }];

function setup(request: any) {
  const source = readFileSync(new URL("../electron/editor-harness-backend.cjs", import.meta.url), "utf8");
  const module = { exports: {} as any };
  const save = vi.fn();
  vm.runInNewContext(source, { module, console, AbortController, Date, require: (id: string) => {
    if (id === "node:fs") return { existsSync: () => true };
    if (id === "./runtime-utils.cjs") return { atomicWriteJsonSync: vi.fn(), readJsonWithBackupSync: () => ({ value: { "https://example.org|owner": { ready: true, version: 2, workId: "work" } } }) };
    if (id === "./online-game-editor.cjs") return { saveEditorProjects: save, activeEditorSession, selectEditorSession, updateEditorSession, markEditorProjectPendingUpload };
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
  return { backend, run: module.exports.runEditorHarness, summarize: module.exports.summarizeHarnessEventForUi, save };
}

describe("harness billing integration", () => {
  it("rejects a parity creation request on a published project before mutating or saving it", async () => {
    const { backend, run, save } = setup(vi.fn());
    const published = createEditorProject(createBundledGridCard());
    const libraryId = `${published.card.cardId}::${published.card.companion.workId}`;
    backend.onlineWorldEditorProjects.projects = { [libraryId]: published };
    backend.onlineWorldEditorProject = () => published;
    const before = JSON.stringify(published);

    await expect(run(backend, { libraryId, goal: "新建一个功能与猎艳疆土完全一致的新游戏" }))
      .rejects.toMatchObject({ code: "EDITOR_GRID_PARITY_REQUIRES_BLANK_DRAFT" });

    expect(JSON.stringify(published)).toBe(before);
    expect(save).not.toHaveBeenCalled();
    expect(backend.onlineWorldEditorJob).toBeUndefined();
  });

  it("preserves development goals longer than the 24K event budget through model dispatch and checkpoints", async () => {
    const marker = "LONG-GOAL-TAIL-MARKER";
    const goal = `${"长".repeat(26000)}${marker}`;
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("connection closed"), { modelUsage: { points: { total: 80000 } } }));
    const { backend, run } = setup(request);
    await expect(run(backend, { libraryId: "draft", goal })).rejects.toMatchObject({ code: "HARNESS_BUDGET_EXHAUSTED" });
    expect(backend.onlineWorldEditorJob.goal).toBe(goal);
    expect(request).toHaveBeenCalledTimes(1);
    const dispatchedQuery = request.mock.calls[0]?.[1];
    expect(dispatchedQuery).toBeTypeOf("string");
    expect(dispatchedQuery).toContain(marker);
    expect(backend.onlineWorldEditorProjects.projects.draft.harnessCandidate.goal).toBe(goal);
    expect(activeEditorSession(backend.onlineWorldEditorProjects.projects.draft)).toMatchObject({ goal, status: "paused" });
  });
  it("does not impose an HTML maxlength on the development goal", () => {
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const field = html.match(/<textarea\s+id="online-editor-agent-goal"[^>]*>/)?.[0];
    expect(field).toBeTruthy();
    expect(field).not.toMatch(/\bmaxlength\s*=/i);
  });
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

describe("editor harness public timeline events", () => {
  it("keeps the complete live event history after it grows beyond 24 entries", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls++;
      if (calls <= 13) return {
        answer: JSON.stringify({ tool: "read_file", args: { path: "configuration.json" }, summary: `read ${calls}` }),
        points: { total: 5000 }
      };
      throw Object.assign(new Error("budget boundary"), { modelUsage: { points: { total: 15000 } } });
    });
    const { backend, run } = setup(request);

    await expect(run(backend, { libraryId: "draft", goal: "keep every live event", budgetPoints: 80000 }))
      .rejects.toMatchObject({ code: "HARNESS_BUDGET_EXHAUSTED" });

    const events = backend.onlineWorldEditorJob.events;
    expect(events.length).toBeGreaterThan(24);
    expect(events[0]).toMatchObject({ turn: 1, kind: "status", tool: "model" });
    expect(events.some((event: any) => event.turn === 13 && event.kind === "tool-result" && event.tool === "read_file")).toBe(true);
    expect(backend.onlineWorldEditorProjects.projects.draft.harnessCandidate.events.length).toBe(events.length);
    expect(activeEditorSession(backend.onlineWorldEditorProjects.projects.draft).events).toHaveLength(events.length);
  });

  it("keeps read/search evidence visible and marks bounded truncation explicitly", () => {
    const { summarize } = setup(vi.fn());
    const read = summarize({
      tool: "read_file",
      result: { path: "program.html", content: "PUBLIC-READ-CONTENT", total: 19 }
    });
    const search = summarize({
      tool: "search_file",
      result: { path: "program.html", offset: 42, content: "PUBLIC-SEARCH-CONTEXT" }
    });
    expect(read.result.content).toBe("PUBLIC-READ-CONTENT");
    expect(search.result.content).toBe("PUBLIC-SEARCH-CONTEXT");

    const oversized = `VISIBLE-START-${"x".repeat(26000)}-HIDDEN-END`;
    for (const tool of ["read_file", "search_file"]) {
      const bounded = summarize({ tool, result: { content: oversized } });
      expect(bounded.result.content).toMatchObject({ characters: oversized.length, truncated: true });
      expect(bounded.result.content.preview).toContain("VISIBLE-START");
      expect(bounded.result.content.preview).not.toContain("HIDDEN-END");
      expect(bounded.result.content.preview.length).toBeLessThanOrEqual(24000);
    }
  });

  it("publishes source mutations as metadata and removes private reasoning recursively", () => {
    const { summarize } = setup(vi.fn());
    const source = "const privateSource = true;\n".repeat(2000);
    const event = summarize({
      tool: "patch_file",
      analysis: "top-level private reasoning",
      args: {
        path: "program.html",
        oldText: source,
        newText: `${source}updated`,
        reasoning: "nested private reasoning",
        nested: { chain_of_thought: "deeper private reasoning", label: "public label" }
      },
      result: { written: "program.html", characters: source.length, privateReasoning: "result private reasoning" }
    });

    expect(event.args).toMatchObject({
      path: "program.html",
      oldText: { omitted: true, characters: source.length },
      newText: { omitted: true, characters: source.length + "updated".length },
      nested: { label: "public label" }
    });
    expect(event.result).toMatchObject({ written: "program.html", characters: source.length });
    expect(JSON.stringify(event)).not.toContain("privateSource");
    expect(JSON.stringify(event)).not.toContain("private reasoning");
  });

  it("bounds the entire public event and sanitizes serialized feedback", () => {
    const { summarize } = setup(vi.fn());
    const event = summarize({
      tool: "consult",
      meta: { Reasoning: "META-SECRET", nested: { internal_reasoning: "NESTED-SECRET", visible: "kept" } },
      result: { values: Array.from({ length: 10000 }, (_, index) => index) },
      coordinator: { feedback: [{ answer: JSON.stringify({ summary: "public", THINKING: "ANSWER-SECRET", nested: { visible: "answer kept" } }) }] }
    });
    const encoded = JSON.stringify(event);
    expect(encoded.length).toBeLessThanOrEqual(24000);
    expect(encoded).toContain("kept");
    expect(encoded).toContain("omitted");
    expect(encoded).not.toContain("META-SECRET");
    expect(encoded).not.toContain("NESTED-SECRET");
    expect(encoded).not.toContain("ANSWER-SECRET");
  });

  it("keeps only a lightweight completion result in broadcast state", async () => {
    let developCall = 0;
    const request = vi.fn(async (_workId: string, query: string) => {
      if (query.startsWith("你是独立游戏质量评审")) return { answer: JSON.stringify({ approved: true, issues: [], summary: "approved" }), points: { total: 1000 } };
      const decisions = [
        { tool: "test_game", args: {}, summary: "test" },
        { tool: "review", args: {}, summary: "review" },
        { tool: "finish", args: {}, summary: "finish" }
      ];
      return { answer: JSON.stringify(decisions[developCall++]), points: { total: 1000 } };
    });
    const { backend, run } = setup(request);
    backend.onlineWorldEditorProjects.projects.draft.configuration.app.name = "完成记录验证";
    backend.onlineWorldEditorProjects.projects.draft.configuration.app.summary = "验证完成状态只广播摘要";

    await run(backend, { libraryId: "draft", goal: "complete", budgetPoints: 80000 });

    expect(backend.onlineWorldEditorJob.status).toBe("completed");
    expect(backend.onlineWorldEditorJob.result).toMatchObject({ status: "completed", review: { approved: true } });
    expect(backend.onlineWorldEditorJob.result).not.toHaveProperty("events");
    expect(backend.onlineWorldEditorJob.result).not.toHaveProperty("goal");
    expect(backend.onlineWorldEditorJob.result).not.toHaveProperty("coordinator");
    expect(activeEditorSession(backend.onlineWorldEditorProjects.projects.draft)).toMatchObject({ goal: "complete", status: "completed" });
  });
});
