import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { runGameHarness, parseDecision, publicHarnessActionArgs, publicHarnessEvent, validateFile, validateTests, fingerprint, projectFiles } = require("../electron/game-harness.cjs");
const { createBlankEditorProject } = require("../electron/online-game-editor.cjs");
const { createGameCardFromEditorProject } = require("../electron/online-world-card.cjs");
const { injectSandboxCsp } = require("../electron/online-world-runtime.cjs");
const { OnlineWorldService } = require("../electron/online-world-service.cjs");
const { savePath, readSave, writeSave, validateSave } = require("../electron/standalone-game.cjs");

function modelHarness(decisions: any[], review: any = { approved: true, issues: [] }) {
  const queries: any[] = [];
  const request = vi.fn(async (input: any) => {
    queries.push(input);
    if (input.kind === "review") return { parsed: review, modelKey: "claude-opus-4-6" };
    const choice = decisions.shift() || { tool: "finish", args: {} };
    return { answer: JSON.stringify(choice), parsed: parseDecision(JSON.stringify(choice)), modelKey: "gpt-5.6", modelLabel: "GPT 5.6" };
  });
  return { request, queries };
}
const step = (tool: string, args = {}) => ({ tool, args, summary: tool });

describe("autonomous game harness", () => {
  it("keeps the primary model and expert feedback beyond the rolling history and 24 turns", async () => {
    const project = createBlankEditorProject();
    project.configuration.app = { ...project.configuration.app, name: "预算回归", summary: "持续协作验证" };
    const decisions = [step("update_plan", { notes: "先验证能量，再实现奖励；保留顾问指出的状态恢复问题" }), step("consult", { question: "检查存档恢复问题" }),
      ...Array.from({ length: 25 }, () => step("read_file", { path: "configuration.json" })), step("test_game"), step("review"), step("finish")];
    const queries: any[] = [];
    const request = vi.fn(async (input: any) => {
      queries.push(input);
      if (input.kind === "consult") return { parsed: { summary: "核查事件顺序", issues: ["先读存档再开启操作"], suggestions: ["等待宿主 state"] }, modelKey: "claude-opus-4-6" };
      if (input.kind === "review") return { parsed: { approved: true, issues: [] }, modelKey: "claude-opus-4-6" };
      const decision = decisions.shift();
      return { parsed: decision, modelKey: "gpt-5.6" };
    });
    const next = await runGameHarness({ project, goal: "回归", request, testGame: async () => ({ passed: true }) });
    expect(queries.filter(q => q.kind === "develop").length).toBeGreaterThan(24);
    expect(queries.filter(q => q.kind === "develop").slice(1).every(q => q.preferredModel === "gpt-5.6")).toBe(true);
    expect(queries.at(-1).query).toContain("等待宿主 state");
    expect(queries.at(-1).query).toContain("先验证能量");
    expect(next.harness.coordinator.primaryModel).toBe("gpt-5.6");
    expect(next.harness.events.length).toBeGreaterThan(24);
    expect(next.harness.events[0]).toMatchObject({ turn: 1, kind: "status", tool: "model" });
  });
  it("propagates budget pauses from an expert without treating them as retryable tool errors", async () => {
    const budgetError = Object.assign(new Error("积分预算已用完"), { code: "HARNESS_BUDGET_EXHAUSTED", retryable: false });
    const request = vi.fn(async ({ kind }: any) => { if (kind === "consult") throw budgetError; return { parsed: step("consult", { question: "检查玩法" }), modelKey: "gpt-5.6" }; });
    await expect(runGameHarness({ project: createBlankEditorProject(), goal: "x", request, testGame: vi.fn() })).rejects.toBe(budgetError);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("feeds failed execution to the model, repairs source, and requires independent review", async () => {
    const project = createBlankEditorProject();
    project.configuration.app.name = "测试探索";
    project.configuration.app.summary = "三段探索与胜负闭环";
    const fixed = project.program.html.replace("遗迹探索", "新的探索");
    const mock = modelHarness([step("read_file", { path: "program.html" }), step("test_game"), step("write_file", { path: "program.html", content: fixed }), step("test_game"), step("review"), step("finish")]);
    const testGame = vi.fn().mockResolvedValueOnce({ passed: false, errors: ["找不到启动按钮"] }).mockResolvedValueOnce({ passed: true, scenarios: [{}] });
    const checkpoints: any[] = [];
    const next = await runGameHarness({ project, goal: "修复探索", request: mock.request, testGame, checkpoint: async (c: any) => checkpoints.push(c) });
    expect(next.program.html).toBe(fixed);
    expect(project.program.html).not.toBe(fixed);
    expect(next.harness.models).toEqual(["gpt-5.6", "claude-opus-4-6"]);
    expect(mock.queries[2].query).toContain("找不到启动按钮");
    const reviewQuery = mock.queries.find(q => q.kind === "review").query;
    expect(JSON.parse(reviewQuery.slice(reviewQuery.indexOf("\n") + 1)).files["program.html"]).toBe(fixed);
    expect(checkpoints.some(c => c.events.some((e: any) => e.result?.passed === false))).toBe(true);
  });
  it("records public read/search content while redacting write and patch source arguments", async () => {
    const project = createBlankEditorProject();
    const mock = modelHarness([
      step("read_file", { path: "configuration.json", limit: 24000 }),
      step("search_file", { path: "configuration.json", query: '"app"' })
    ]);
    const checkpoints: any[] = [];

    await expect(runGameHarness({
      project,
      goal: "inspect public evidence",
      request: mock.request,
      testGame: vi.fn(),
      maxTurns: 2,
      checkpoint: async (value: any) => checkpoints.push(value)
    })).rejects.toThrow("预算");

    const results = checkpoints.at(-1).events.filter((event: any) => event.kind === "tool-result");
    const read = results.find((event: any) => event.tool === "read_file").result;
    const search = results.find((event: any) => event.tool === "search_file").result;
    expect(read.content).toContain('"app"');
    expect(read.total).toBeGreaterThanOrEqual(read.content.length);
    expect(search.content).toContain('"app"');
    expect(search.offset).toBeGreaterThanOrEqual(0);

    const largeSource = "source-line\n".repeat(4000);
    const write = publicHarnessActionArgs("write_file", { path: "program.html", content: largeSource, analysis: "hidden" });
    const patch = publicHarnessActionArgs("patch_file", {
      path: "program.html",
      expectedSha256: "hash",
      oldText: largeSource,
      newText: `${largeSource}changed`,
      reasoning: "hidden"
    });
    expect(write).toEqual({ path: "program.html", content: { omitted: true, characters: largeSource.length } });
    expect(patch).toEqual({
      path: "program.html",
      expectedSha256: "hash",
      oldText: { omitted: true, characters: largeSource.length },
      newText: { omitted: true, characters: largeSource.length + "changed".length }
    });
    expect(JSON.stringify({ write, patch })).not.toContain("source-line");
    expect(publicHarnessActionArgs("read_file", {
      path: "program.html",
      analysis: "hidden",
      nested: { thought: "hidden deeper", visible: "kept" }
    })).toEqual({ path: "program.html", nested: { visible: "kept" } });
  });
  it("preserves model summaries and tool errors beyond the former silent limits", async () => {
    const summary = `SUMMARY-START-${"s".repeat(2400)}-SUMMARY-END`;
    const error = `ERROR-START-${"e".repeat(3200)}-ERROR-END`;
    const mock = modelHarness([
      { tool: "read_file", args: { path: "configuration.json" }, summary },
      step("test_game")
    ]);
    const checkpoints: any[] = [];

    await expect(runGameHarness({
      project: createBlankEditorProject(),
      goal: "keep complete public messages",
      request: mock.request,
      testGame: async () => { throw new Error(error); },
      maxTurns: 2,
      checkpoint: async (value: any) => checkpoints.push(value)
    })).rejects.toThrow("预算");

    const events = checkpoints.at(-1).events;
    expect(events.find((event: any) => event.kind === "assistant-action" && event.tool === "read_file").summary).toBe(summary);
    expect(events.find((event: any) => event.kind === "error" && event.tool === "test_game").error).toBe(error);
  });
  it("continues a candidate timeline without replacing its earlier events", async () => {
    const project = createBlankEditorProject();
    project.harness.events = [{ at: 1, turn: 7, kind: "tool-result", tool: "read_file", summary: "EARLIER-EVENT" }];
    const checkpoints: any[] = [];
    await expect(runGameHarness({
      project,
      goal: "continue",
      request: async () => { throw new Error("stop after checkpoint"); },
      testGame: vi.fn(),
      maxTurns: 1,
      checkpoint: async (value: any) => checkpoints.push(value)
    })).rejects.toThrow("stop after checkpoint");
    expect(checkpoints[0].events[0]).toMatchObject({ turn: 7, summary: "EARLIER-EVENT" });
    expect(checkpoints[0].events.at(-1)).toMatchObject({ turn: 1, kind: "status", tool: "model" });
  });
  it("bounds public events and removes normalized private keys and serialized answers", () => {
    const serialized = publicHarnessEvent({
      tool: "consult",
      feedback: {
        answer: JSON.stringify({ summary: "public lower", chain_of_thought: "SECRET-C" }),
        Answer: JSON.stringify({ summary: "public upper", THINKING: "SECRET-D" }),
        ANSWER: JSON.stringify({ summary: "public caps", private_reasoning: "SECRET-E" })
      }
    });
    const serializedText = JSON.stringify(serialized);
    expect(serializedText).toContain("public lower");
    expect(serializedText).toContain("public upper");
    expect(serializedText).toContain("public caps");
    expect(serializedText).not.toContain("SECRET-C");
    expect(serializedText).not.toContain("SECRET-D");
    expect(serializedText).not.toContain("SECRET-E");

    const event = publicHarnessEvent({
      tool: "consult",
      summary: `START-${"x".repeat(30000)}-END`,
      meta: { Reasoning: "SECRET-A", internal_reasoning: "SECRET-B", visible: "kept" },
      result: { values: Array.from({ length: 10000 }, (_, index) => index) },
      feedback: { answer: JSON.stringify({ summary: "public", chain_of_thought: "SECRET-C" }) }
    });
    const encoded = JSON.stringify(event);
    expect(encoded.length).toBeLessThanOrEqual(24000);
    expect(event.summary).toMatchObject({ truncated: true, characters: 30010 });
    expect(encoded).not.toContain("SECRET-A");
    expect(encoded).not.toContain("SECRET-B");
    expect(encoded).not.toContain("SECRET-C");
    expect(encoded).not.toContain("-END");
  });
  it("keeps review control fields outside the public event budget", async () => {
    const project = createBlankEditorProject();
    project.configuration.app.name = "长评审回归";
    project.configuration.app.summary = "评审摘要超过展示预算时仍可完成";
    const longSummary = `${"评".repeat(26000)}-SUMMARY-END`;
    const review = { summary: longSummary, approved: true, issues: [{ visible: "kept", Thinking: "PRIVATE-REVIEW" }] };
    const mock = modelHarness([step("test_game"), step("review"), step("finish")], review);

    const next = await runGameHarness({ project, goal: "complete after long review", request: mock.request, testGame: async () => ({ passed: true }), maxTurns: 3 });

    expect(next.harness.status).toBe("completed");
    expect(next.harness.review.approved).toBe(true);
    expect(next.harness.review.issues).toEqual([{ visible: "kept" }]);
    expect(next.harness.review.summary).toBe(longSummary);
    expect(JSON.stringify(next.harness.review)).not.toContain("PRIVATE-REVIEW");
    const reviewEvent = next.harness.events.find((event: any) => event.kind === "review");
    expect(JSON.stringify(reviewEvent).length).toBeLessThanOrEqual(24000);
  });
  it("rejects finish without real tests and preserves the original", async () => {
    const project = createBlankEditorProject();
    const snapshot = JSON.stringify(project);
    const { request } = modelHarness([step("finish")]);
    await expect(runGameHarness({ project, goal: "x", request, testGame: vi.fn(), maxTurns: 1 })).rejects.toThrow("预算");
    expect(JSON.stringify(project)).toBe(snapshot);
  });
  it("invalidates both execution and review evidence after any file change", async () => {
    const project = createBlankEditorProject();
    const { request } = modelHarness([step("test_game"), step("review"), step("write_file", { path: "program.html", content: project.program.html + "\n<!-- new -->" }), step("finish")]);
    await expect(runGameHarness({ project, goal: "x", request, testGame: async () => ({ passed: true }), maxTurns: 4 })).rejects.toThrow("预算");
  });
  it("returns critical review issues to the developer and does not auto-approve", async () => {
    const project = createBlankEditorProject();
    const mock = modelHarness([step("test_game"), step("review"), step("finish")], { approved: false, issues: ["实际玩法与目标不符"] });
    await expect(runGameHarness({ project, goal: "x", request: mock.request, testGame: async () => ({ passed: true }), maxTurns: 3 })).rejects.toThrow("预算");
    expect(mock.queries.at(-1).query).toContain("实际玩法与目标不符");
  });
  it("cancels between tools and does not apply a half-finished project", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runGameHarness({ project: createBlankEditorProject(), goal: "x", request: vi.fn(), testGame: vi.fn(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("keeps fingerprints stable when packaging inserts CSP", () => {
    const files = projectFiles(createBlankEditorProject());
    expect(fingerprint(files)).toBe(fingerprint({ ...files, "program.html": injectSandboxCsp(files["program.html"]) }));
    expect(fingerprint(files)).toBe(fingerprint({ ...files, "configuration.json": JSON.stringify(JSON.parse(files["configuration.json"])), "program.html": files["program.html"].trim() }));
  });
  it.each(["../../main.cjs", "credentials.json", "https://example.org/a"])("rejects virtual file escape %s", path => {
    expect(() => validateFile(path, "{}" )).toThrow("虚拟");
  });
  it("rejects identity edits, fake tests and empty assertions", () => {
    expect(() => validateFile("configuration.json", '{"app":{"id":"bad"}}')).toThrow();
    expect(() => validateTests({ scenarios: [] })).toThrow();
    const tests = createBlankEditorProject().harness.tests;
    tests.scenarios[0].terminal.includes = "";
    expect(() => validateTests(tests)).toThrow();
    expect(() => parseDecision('{"tool":"shell","args":{}}')).toThrow();
  });
});

describe("standalone lobby runtime", () => {
  it("opens a non-grid card for a guest without grid initialization, persists progress and isolates identities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fyow-harness-runtime-"));
    try {
      const author = "c6ca1964-4444-4444-8444-22b487001450";
      const guest = "c6ca1964-3333-4333-8333-22b487001450";
      const workId = "c6ca1964-1111-4111-8111-22b487001450";
      const project = createBlankEditorProject({ origin: "https://acepro.store", accountId: author });
      const card = createGameCardFromEditorProject(project, { origin: "https://acepro.store", authorAccountId: author, workId });
      const detail = { id: workId, name: "独立探索", author: { id: author }, description: card.companion.configuration.app.description };
      let currentAccount = guest;
      const service = new OnlineWorldService({ cacheFile: join(dir, "cache.json"), getAccount: () => ({ accountId: currentAccount }), getOrigin: () => "https://acepro.store", requestConsole: async () => detail, requestGo: async () => detail });
      service.calibrateClock = async () => {};
      service.sync = vi.fn(async () => { throw Error("must not sync grid ledger"); });
      service.startPolling = vi.fn();
      const state = await service.open({ card });
      expect(state).toMatchObject({ runtime: "standalone/1", initialized: true, isServerOwner: false, status: "ready" });
      expect(service.sync).not.toHaveBeenCalled();
      expect(service.startPolling).not.toHaveBeenCalled();
      service.saveStandaloneState({ workId, gameId: card.gameId, data: { version: 1, step: 2 } });
      await service.pause();
      expect(() => service.saveStandaloneState({ workId, gameId: card.gameId, data: {} })).toThrow();
      expect((await service.open({ card })).gameSave).toEqual({ version: 1, step: 2 });
      expect(savePath(join(dir, "cache.json"), author, card)).not.toBe(savePath(join(dir, "cache.json"), guest, card));
      expect(() => service.saveStandaloneState({ workId: "other", gameId: card.gameId, data: {} })).toThrow("其他游戏");
      currentAccount = author;
      expect(service.state().gameSave).toBeNull();
      expect(() => service.saveStandaloneState({ workId, gameId: card.gameId, data: {} })).toThrow("账号");
      currentAccount = guest;
      await service.forgetOpenedCard();
      expect(service.state().card).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("checks save size, restores backups, and rejects non-object state", () => {
    const dir = mkdtempSync(join(tmpdir(), "fyow-save-"));
    try {
      const file = join(dir, "save.json");
      writeSave(file, { step: 1 });
      expect(readSave(file)).toEqual({ step: 1 });
      expect(() => validateSave([])).toThrow();
      expect(() => validateSave({ text: "x".repeat(60001) })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
