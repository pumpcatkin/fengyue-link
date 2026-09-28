import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { runGameHarness, parseDecision, validateFile, validateTests, fingerprint, projectFiles } = require("../electron/game-harness.cjs");
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
