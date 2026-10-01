import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createBundledGridCard,
  createEditedGameCard,
  decomposeGameCard,
  validateGameCard
} = require("../electron/online-world-card.cjs");
const {
  DEFAULT_AGENT_COMPONENTS,
  ONLINE_WORLD_EDITOR_PLAYBOOK,
  createEditorProject,
  createBlankEditorProject,
  createImportedEditorProject,
  loadEditorProjects,
  normalizeEditorProject,
  normalizeAgentSynthesis,
  applyAgentSynthesis,
  parseAgentAnswer,
  parseStructuredAgentAnswer,
  readOnlineWorldEditorImportFile,
  saveEditorProjects
} = require("../electron/online-game-editor.cjs");
const { rankEditorModels } = require("../electron/auto-model-router.cjs");
const { injectSandboxCsp, packProgram } = require("../electron/online-world-runtime.cjs");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("online game editor projects", () => {
  it("decomposes a validated card into editable program and configuration sections", () => {
    const card = createBundledGridCard();
    const project = createEditorProject(card);
    expect(project.schema).toBe("fyow.game-card-editor/1");
    expect(project.card.workId ?? project.card.companion.workId).toBe(card.companion.workId);
    expect(project.program.html).toContain("<!doctype html>");
    expect(project.configuration.world_book).toHaveLength(card.companion.configuration.world_book.length);
    expect(project.agents.map((item: any) => item.id)).toEqual(DEFAULT_AGENT_COMPONENTS.map((item: any) => item.id));
  });

  it("rebuilds a card from edited HTML and structured configuration", () => {
    const original = createBundledGridCard();
    const project = createEditorProject(original);
    project.card.title = "编辑后的世界";
    project.configuration.app.name = "编辑后的作品";
    project.configuration.pre_prompt = "新的世界观";
    project.program.html = "<!doctype html><html><body><main>editor</main></body></html>";
    const edited = validateGameCard(createEditedGameCard(original, {
      title: project.card.title,
      configuration: project.configuration,
      programHtml: project.program.html
    }));
    expect(edited.title).toBe("编辑后的世界");
    expect(edited.companion.configuration.app.name).toBe("编辑后的作品");
    expect(edited.companion.configuration.pre_prompt).toBe("新的世界观");
    expect(edited.program.digest).not.toBe(original.program.digest);
    expect(edited.version).toBe(original.version + 1);
  });

  it("persists normalized editor projects and parses fenced Agent JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-editor-project-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    const project = normalizeEditorProject({ card: { title: "测试" }, agents: [{ id: "architect", enabled: false }] });
    saveEditorProjects(file, { "card::work": project });
    const loaded = loadEditorProjects(file);
    expect(loaded.projects["card::work"].agents.find((item: any) => item.id === "architect").enabled).toBe(false);
    expect(parseAgentAnswer("```json\n{\"approved\":true}\n```")).toEqual({ approved: true });
    expect(parseAgentAnswer("plain text")).toEqual({ text: "plain text" });
    expect(parseStructuredAgentAnswer("{\"approved\":true}", "测试 Agent")).toEqual({ approved: true });
    expect(() => parseStructuredAgentAnswer("plain text", "测试 Agent")).toThrow("未返回有效 JSON");
    for (const answer of ["[]", "{}", "null"]) {
      expect(() => parseStructuredAgentAnswer(answer)).toThrow();
    }
    expect(() => parseStructuredAgentAnswer('{"summary":"done"}', "中枢", { synthesis: true })).toThrow("审查结论");
  });

  it("keeps all prompt sections visible in the normalized project snapshot", () => {
    const project = normalizeEditorProject({
      configuration: {
        app: { name: "提示词测试" },
        pre_text: "全局前置",
        pre_prompt: "世界观前置",
        post_text: "严格后置",
        world_book: [{ key: "task", value: "只返回 JSON" }]
      }
    });
    expect(project.configuration).toMatchObject({
      pre_text: "全局前置",
      pre_prompt: "世界观前置",
      post_text: "严格后置",
      world_book: [{ key: "task", value: "只返回 JSON" }]
    });
  });

  it("ships the card-specific host and network rules to every editor agent", () => {
    const playbook = JSON.stringify(ONLINE_WORLD_EDITOR_PLAYBOOK);
    expect(playbook).toContain("fyow-host/1");
    expect(playbook).toContain("1000ms");
    expect(playbook).toContain("idempotencyKey");
    expect(DEFAULT_AGENT_COMPONENTS.map((item: any) => item.id)).toContain("runtime-network-engineer");
  });

  it("creates a local-only blank draft without a companion work", () => {
    const project = createBlankEditorProject({
      origin: "https://staging.aiero.cc",
      accountId: "39404f0e-7678-45a1-86c6-9a21116bacbd"
    });
    expect(project.isDraft).toBe(true);
    expect(project.card.companion.workId).toBe("");
    expect(project.card.companion.authorAccountId).toBe("39404f0e-7678-45a1-86c6-9a21116bacbd");
    expect(project.program.html).toContain("standalone/1");
    expect(project.harness.tests.scenarios).toHaveLength(2);
    expect(project.program.html).toContain("fyow-host/1");
    expect(project.program.html).toContain('send("ready",{capabilities:["flush-save/1"]})');
    expect(project.agents.every((item: any) => item.workId === "")).toBe(true);
  });

  it("imports an editor project as a detached draft with fresh local identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-editor-import-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "project.json");
    writeFileSync(file, JSON.stringify({
      schema: "fyow.game-card-editor/1",
      draftId: "draft-from-another-install",
      revision: 17,
      pendingPublication: { workId: "remote-work-id" },
      card: {
        cardId: "cc.aiero.fyow.imported",
        gameId: "fyow-imported-game",
        title: "导入项目",
        version: 8,
        exportedAt: "2026-09-30T00:00:00.000Z",
        companion: { origin: "https://old.example", workId: "old-work-id", authorAccountId: "old-account-id" }
      },
      program: { html: "<!doctype html><html><body>imported</body></html>", digest: "old-digest" },
      configuration: { app: { id: "old-work-id", name: "导入项目" }, pre_prompt: "旧世界观" },
      validation: { packageSha256: "old-package" },
      harness: { status: "passed", evidence: { passed: true }, review: { approved: true } }
    }));
    const loaded = readOnlineWorldEditorImportFile(file);
    expect(loaded.type).toBe("editor-project");
    const project = createImportedEditorProject(loaded.projects[0], {
      origin: "https://staging.aiero.cc",
      accountId: "39404f0e-7678-45a1-86c6-9a21116bacbd"
    });
    expect(project.draftId).toMatch(/^draft-[a-f0-9]{16}$/);
    expect(project.draftId).not.toBe("draft-from-another-install");
    expect(project.isDraft).toBe(true);
    expect(project.revision).toBe(0);
    expect(project.card).toMatchObject({ title: "导入项目", version: 0, exportedAt: null });
    expect(project.card.companion).toMatchObject({
      origin: "https://staging.aiero.cc",
      workId: "",
      authorAccountId: "39404f0e-7678-45a1-86c6-9a21116bacbd"
    });
    expect(project.configuration.app.id).toBe("");
    expect(project.program.html).toContain("imported");
    expect(project.program.digest).toBe("");
    expect(project.pendingPublication).toBeNull();
    expect(project.validation).toBeNull();
    expect(project.harness.status).toBe("needs-test");
    expect(project.harness.evidence).toBeNull();
    expect(project.harness.review).toBeNull();
  });

  it("expands editor project backups and gives every imported project a distinct draft id", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-editor-backup-import-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    writeFileSync(file, JSON.stringify({
      schema: "fyow.game-card-editor-projects/1",
      projects: {
        first: { schema: "fyow.game-card-editor/1", card: { title: "项目一" }, program: { html: "<main>one</main>" } },
        second: { schema: "fyow.game-card-editor/1", card: { title: "项目二" }, program: { html: "<main>two</main>" } }
      }
    }));
    const loaded = readOnlineWorldEditorImportFile(file);
    expect(loaded.type).toBe("editor-projects");
    expect(loaded.projects).toHaveLength(2);
    const projects = loaded.projects.map((item: any) => createImportedEditorProject(item, {
      origin: "https://staging.aiero.cc", accountId: "current-account-id"
    }));
    expect(new Set(projects.map((item: any) => item.draftId)).size).toBe(2);
    expect(projects.map((item: any) => item.card.title)).toEqual(["项目一", "项目二"]);
  });

  it("normalizes schema-less platform configurations and restores packaged programs when present", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-platform-config-import-"));
    temporaryDirectories.push(directory);
    const plainFile = join(directory, "plain.json");
    writeFileSync(plainFile, JSON.stringify({
      name: "平台作品",
      intro: "普通详细介绍",
      ppt: "世界观别名",
      world_bk: [{ key: "rule", value: "规则" }]
    }));
    const plainLoaded = readOnlineWorldEditorImportFile(plainFile);
    const plain = createImportedEditorProject(plainLoaded.projects[0], {
      origin: "https://staging.aiero.cc", accountId: "current-account-id"
    });
    expect(plainLoaded.type).toBe("platform-configuration");
    expect(plain.configuration).toMatchObject({
      app: { id: "", name: "平台作品", description: "普通详细介绍" },
      pre_prompt: "世界观别名",
      world_book: [{ key: "rule", value: "规则" }]
    });
    expect(plain.harness.status).toBe("needs-implementation");
    expect(plain.program.html).toContain("standalone/1");

    const packedFile = join(directory, "packed.json");
    const packed = packProgram({ gameId: "fyow-platform-game", title: "带程序作品", html: "<!doctype html><html><body>playable</body></html>" });
    writeFileSync(packedFile, JSON.stringify({ name: "带程序作品", description: packed.envelope }));
    const packedLoaded = readOnlineWorldEditorImportFile(packedFile);
    const restored = createImportedEditorProject(packedLoaded.projects[0], {
      origin: "https://staging.aiero.cc", accountId: "current-account-id"
    });
    expect(restored.card.gameId).toBe("fyow-platform-game");
    expect(restored.program.html).toContain("playable");
    expect(restored.harness.status).toBe("needs-test");
  });

  it("keeps runtime card validation strict and returns actionable format errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-editor-format-import-"));
    temporaryDirectories.push(directory);
    const runtimeCardFile = join(directory, "card.json");
    writeFileSync(runtimeCardFile, JSON.stringify(createBundledGridCard()));
    expect(readOnlineWorldEditorImportFile(runtimeCardFile).type).toBe("game-card");
    for (const [name, value, message] of [
      ["v2.json", { schema: "fyow.game-card/2" }, "/2 格式尚未实现"],
      ["library.json", { schema: "fyow.game-card-library/1", cards: [] }, "单张 fyow.game-card/1"],
      ["unknown.json", { schema: "fyow.unknown/9" }, "不支持的作品编辑器格式"]
    ] as const) {
      const file = join(directory, name);
      writeFileSync(file, JSON.stringify(value));
      expect(() => readOnlineWorldEditorImportFile(file)).toThrow(message);
    }
  });

  it("repairs the old static starter card into a host-connected program", () => {
    const html = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>未命名游戏</title></head>
  <body><main><h1>未命名游戏</h1><p>从这里开始设计你的游戏卡。</p></main></body>
</html>`;
    const project = normalizeEditorProject({
      program: {
        html: injectSandboxCsp(html)
      }
    });
    expect(project.program.html).toContain("fyow-host/1");
    expect(project.program.html).toContain('send("ready",{capabilities:["flush-save/1"]})');
    const customHtml = html.replace("</main>", "<button>玩家自定义内容</button></main>");
    expect(normalizeEditorProject({ program: { html: customHtml } }).program.html).toBe(customHtml);
  });

  it("returns only an allowlisted synthesis patch to the editor project", () => {
    const project = createBlankEditorProject();
    const synthesis = normalizeAgentSynthesis({
      summary: "补齐开局说明",
      configurationPatch: {
        app: { name: "新名字", summary: "新简介", id: "不要覆盖" },
        pre_prompt: "新的世界观",
        world_book: [{ key: "opening", value: "开局" }],
        program: "<script>ignored</script>",
        companion: { workId: "ignored" }
      }
    });
    expect(synthesis.configurationPatch).toEqual({
      app: { name: "新名字", summary: "新简介" },
      pre_prompt: "新的世界观",
      world_book: [{ key: "opening", value: "开局" }]
    });
    const applied = applyAgentSynthesis(project, synthesis);
    expect(applied.configuration.app.id).toBe("");
    expect(applied.configuration.app.name).toBe("新名字");
    expect(applied.configuration.pre_prompt).toBe("新的世界观");
    expect(applied.program.html).toBe(project.program.html);
  });

  it("keeps the project unchanged when the central verifier rejects a synthesis", () => {
    const project = createBlankEditorProject();
    const synthesis = normalizeAgentSynthesis({
      summary: "发现程序没有宿主握手",
      approved: false,
      configurationPatch: { pre_prompt: "不应写入" }
    });
    expect(synthesis.accepted).toBe(false);
    expect(applyAgentSynthesis(project, synthesis)).toEqual(project);
  });

  it("prioritizes editor model families before general catalog ranking", () => {
    const ranked = rankEditorModels([
      { model: "glm-5.3", label: "GLM 5.3", price: 1, successRate: 90 },
      { model: "claude-opus-4.6", label: "Claude Opus 4.6", price: 1, successRate: 90 },
      { model: "gpt-5.6", label: "GPT 5.6", price: 1, successRate: 90 },
      { model: "other-model", label: "Other", price: 0, successRate: 100 }
    ]);
    expect(ranked.map((item: any) => item.model)).toEqual(["gpt-5.6", "claude-opus-4.6", "glm-5.3", "other-model"]);
  });
});

describe("editor harness dispatch", () => {
  it("routes editor-project imports into detached local drafts instead of the runtime card reader", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-editor-backend-import-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "project.json");
    writeFileSync(file, JSON.stringify({
      schema: "fyow.game-card-editor/1",
      draftId: "foreign-draft",
      card: {
        title: "后端导入草稿",
        companion: { origin: "https://old.example", workId: "foreign-work", authorAccountId: "foreign-account" }
      },
      program: { html: "<main>backend import</main>" },
      configuration: { app: { id: "foreign-work", name: "后端导入草稿" } }
    }));
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
      readOnlineWorldEditorImportFile, createImportedEditorProject, saveEditorProjects
    });
    const backend = Object.assign(Object.create(Backend.prototype), {
      account: { accountId: "current-account-id" },
      origin: "https://staging.aiero.cc",
      assertToolLoggedIn: vi.fn(),
      assertOnlineWorldEditorOwner: vi.fn(),
      onlineWorldEditorProjects: { projects: {} },
      onlineWorldEditorFile: join(directory, "stored-projects.json"),
      listOnlineWorldCards: vi.fn(async () => ({ cards: [], activeCardId: null, activeLibraryId: null })),
      listOnlineWorldEditorProjects: vi.fn(function (this: any) {
        return {
          projects: Object.entries(this.onlineWorldEditorProjects.projects).map(([libraryId, project]: any) => this.summarizeOnlineWorldEditorProject(project, libraryId)),
          selectedId: null
        };
      }),
      importOnlineWorldCardFiles: vi.fn()
    });
    const result = await backend.importOnlineWorldEditorCardFiles([file]);
    expect(backend.importOnlineWorldCardFiles).not.toHaveBeenCalled();
    expect(result.importedCards).toHaveLength(1);
    expect(result.imported.libraryId).toMatch(/^draft::draft-[a-f0-9]{16}$/);
    const stored = loadEditorProjects(backend.onlineWorldEditorFile);
    const project = stored.projects[result.imported.libraryId];
    expect(project.card.companion).toMatchObject({
      origin: "https://staging.aiero.cc", workId: "", authorAccountId: "current-account-id"
    });
    expect(project.configuration.app.id).toBe("");
  });

  it("saves unfinished editor drafts without touching the playable card or cloud", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-draft-isolation-"));
    temporaryDirectories.push(directory);
    const cards = require("../electron/online-world-card.cjs");
    const harness = require("../electron/game-harness.cjs");
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
      normalizeEditorProject, saveEditorProjects, summarizeGameCard: cards.summarizeGameCard,
      harnessFingerprint: harness.fingerprint, harnessFiles: harness.projectFiles
    });
    const card = createBundledGridCard(), project = createEditorProject(card);
    const originalHash = card.packageSha256;
    project.program.html = '<html><script src="unfinished.js"></script></html>';
    project.configuration.pre_prompt = "尚未完成但要保存的提示词";
    const backend = Object.assign(Object.create(Backend.prototype), {
      account: { accountId: card.companion.authorAccountId }, origin: card.companion.origin,
      onlineWorldCard: () => card, assertOnlineWorldEditorOwner: vi.fn(),
      onlineWorldEditorProjects: { projects: {} }, onlineWorldEditorFile: join(directory, "projects.json"),
      listOnlineWorldCards: async () => ({ cards: [card] }), listOnlineWorldEditorProjects: () => ({ projects: [] }),
      persistEditedOnlineWorldCard: vi.fn(), onlineWorldService: { updateGameCardCloud: vi.fn() }
    });
    const result = await backend.saveOnlineWorldCardEditor("existing-card", project, { publish: false });
    expect(result.draftSaved).toBe(true);
    expect(result.project.program.html).toContain("unfinished.js");
    expect(loadEditorProjects(backend.onlineWorldEditorFile).projects["existing-card"].configuration.pre_prompt).toBe("尚未完成但要保存的提示词");
    expect(card.packageSha256).toBe(originalHash);
    expect(backend.persistEditedOnlineWorldCard).not.toHaveBeenCalled();
    expect(backend.onlineWorldService.updateGameCardCloud).not.toHaveBeenCalled();
  });
  it("routes the existing editor IPC to the new harness, not a fixed role sequence", async () => {
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const runEditorHarness = vi.fn(async (_backend, payload) => ({ project: payload }));
    const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, { runEditorHarness });
    const backend = Object.create(Backend.prototype);
    const payload = { libraryId: "draft::test", goal: "生成可玩的探索游戏" };
    expect(await backend.runOnlineWorldEditorAgents(payload)).toEqual({ project: payload });
    expect(runEditorHarness).toHaveBeenCalledWith(backend, payload);
    expect(source).not.toContain("runLegacyOnlineWorldEditorAgents");
  });
});
