import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  GRID_PARITY_INTENTS,
  GRID_PARITY_MODEL_TASKS,
  assertGridParityDraftSource,
  assertGridParityProject,
  gridParityCapabilityReport,
  gridParityPrompt,
  gridParityTitle,
  instantiateGridParityProject,
  smokeGridParityRules
} = require("../electron/editor-grid-parity.cjs");
const { createBlankEditorProject, createEditorProject } = require("../electron/online-game-editor.cjs");
const { createBundledGridCard, createGameCardFromEditorProject, decomposeGameCard, validateGameCard } = require("../electron/online-world-card.cjs");
const packageJson = require("../package.json");

const origin = "https://staging.aiero.cc";
const accountId = "39404f0e-7678-45a1-86c6-9a21116bacbd";
const draftIdentity = (project: any) => ({
  libraryId: `draft::${project.draftId}`,
  origin,
  accountId
});
const createParityProject = (goal: string) => {
  const project = createBlankEditorProject({ origin, accountId });
  return instantiateGridParityProject(project, goal, draftIdentity(project));
};

describe("deterministic grid parity creation", () => {
  it("recognizes only an explicit pure-prompt request for full grid parity", () => {
    expect(gridParityPrompt("请新建一个功能与猎艳疆土完全一致的新游戏")).toBe(true);
    expect(gridParityPrompt("复刻猎艳疆土的完整功能并创建新游戏")).toBe(true);
    expect(gridParityPrompt("给猎艳疆土换一个简介")).toBe(false);
    expect(gridParityPrompt("创建一个普通单人文字游戏")).toBe(false);
    expect(gridParityPrompt("不要创建功能与猎艳疆土完全一致的新游戏")).toBe(false);
    expect(gridParityPrompt("实现猎艳疆土完整功能中的积分展示")).toBe(false);
    expect(gridParityPrompt("在现有游戏中实现与猎艳疆土功能一致的聊天面板")).toBe(false);
    expect(gridParityPrompt("创建一款猎艳疆土同款新游戏")).toBe(true);
    expect(gridParityPrompt("照着猎艳疆土做出一个一样的新游戏")).toBe(true);
    expect(gridParityTitle("创建同功能新游戏，名为「群雄疆域」")).toBe("群雄疆域");
  });

  it("turns one prompt into a detached new project with the exact proven engine", () => {
    const original = createBlankEditorProject({ origin, accountId, title: "未命名游戏" });
    const next = instantiateGridParityProject(original,
      "仅凭这段提示词创建一个功能与猎艳疆土完全一致的新游戏，名为「群雄疆域」",
      draftIdentity(original));

    expect(next.card.title).toBe("群雄疆域");
    expect(next.card.gameId).toBe("cc.aiero.fyow.grid-conquest");
    expect(next.card.cardId).toBe(original.card.cardId);
    expect(next.card.companion.workId).toBe("");
    expect(next.card.companion.authorAccountId).toBe(accountId);
    expect(next.isDraft).toBe(true);
    expect(next.harness.mode).toBe("deterministic-grid-parity-template");
    expect(next.harness.evidence.passed).toBe(true);
    expect(next.harness.review.approved).toBe(true);
    expect(next.parity.missing).toEqual([]);
    expect(next.parity.capabilities[0]).toMatchObject({ name: "identity", passed: true });
    expect(assertGridParityProject(next, draftIdentity(original)).passed).toBe(true);
  });

  it("rejects published grid and non-grid projects without mutating either project", () => {
    const publishedGrid = createEditorProject(createBundledGridCard());
    const standaloneDraft = createBlankEditorProject({ origin, accountId, title: "已有单人游戏" });
    const publishedStandalone = createEditorProject(createGameCardFromEditorProject(standaloneDraft, {
      origin,
      authorAccountId: accountId,
      workId: "standalone-work-123"
    }));
    for (const [libraryId, project] of [
      ["cc.aiero.fyow.grid-conquest.official::faeaacf3-8c3a-4338-b2a2-8b704633ebf1", publishedGrid],
      [`${publishedStandalone.card.cardId}::${publishedStandalone.card.companion.workId}`, publishedStandalone]
    ] as const) {
      const before = JSON.stringify(project);
      expect(() => instantiateGridParityProject(project,
        "新建一个功能与猎艳疆土完全一致的新游戏",
        { libraryId, origin, accountId })).toThrow(/只能用于刚创建/);
      expect(JSON.stringify(project)).toBe(before);
    }
  });

  it("requires the blank draft identity to match the active account, origin and draft key", () => {
    const project = createBlankEditorProject({ origin, accountId });
    expect(assertGridParityDraftSource(project, draftIdentity(project))).toMatchObject({
      draftLibraryKey: true,
      currentAuthor: true,
      currentOrigin: true,
      blankProgram: true,
      blankPrompts: true
    });
    expect(() => assertGridParityDraftSource(project, { ...draftIdentity(project), libraryId: "published::work" }))
      .toThrow(/只能用于刚创建/);
    project.configuration.pre_prompt = "已修改";
    expect(() => assertGridParityDraftSource(project, draftIdentity(project))).toThrow(/只能用于刚创建/);
  });

  it("checks every rules, model, protocol, social, admin and interface capability group", () => {
    const project = createParityProject("制作一个与猎艳疆土完整功能等价的新游戏");
    const report = gridParityCapabilityReport(project, draftIdentity(project));
    expect(report.capabilities.map((item: { name: string }) => item.name)).toEqual([
      "identity", "program", "configuration", "model-tasks", "rules", "intents",
      "service", "protocol", "communication", "administration", "interface"
    ]);
    expect(report.capabilities.every((item: { passed: boolean }) => item.passed)).toBe(true);
    expect(GRID_PARITY_INTENTS.length).toBeGreaterThanOrEqual(29);
    expect(GRID_PARITY_MODEL_TASKS).toHaveLength(7);
  });

  it("fails closed when the generated program is only visually similar", () => {
    const project = createParityProject("创建功能与猎艳疆土完全一致的新游戏");
    project.program.html = project.program.html.replace("64乘64大陆地图", "64乘64相似地图");
    const report = gridParityCapabilityReport(project, draftIdentity(project));
    expect(report.passed).toBe(false);
    expect(report.missing).toContain("program:exactProgram");
    expect(() => assertGridParityProject(project)).toThrow(/等价能力验证失败/);
  });

  it("packages the generated draft as a new companion work without losing parity", () => {
    const project = createParityProject("新建一个和猎艳疆土功能一致的新游戏，叫做「九州争霸」");
    const card = createGameCardFromEditorProject(project, {
      origin,
      authorAccountId: accountId,
      workId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    });
    const validated = validateGameCard(card);
    const restored = decomposeGameCard(validated);
    expect(restored.card.title).toBe("九州争霸");
    expect(restored.card.cardId).toBe(project.card.cardId);
    expect(restored.card.gameId).toBe(project.card.gameId);
    expect(restored.card.companion.workId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(restored.program.html.trim()).toBe(project.program.html.trim());
    expect(restored.configuration.pre_prompt).toBe(project.configuration.pre_prompt);
    expect(restored.configuration.world_book).toEqual(project.configuration.world_book);
  });

  it("executes the authoritative join rule and produces the initial model task", () => {
    expect(smokeGridParityRules()).toMatchObject({
      joined: true,
      effects: ["general-generation-request"]
    });
  });

  it("runs the complete parity verifier before every distributable Windows package", () => {
    expect(packageJson.scripts["pack:win"]).toMatch(/^npm run verify:editor-parity && /);
    expect(packageJson.scripts["pack:dir"]).toMatch(/^npm run verify:editor-parity && /);
    expect(packageJson.scripts["pack:release"]).toContain("npm run pack:win");
  });

  it("rejects parity harness preparation before locally saving a published project", () => {
    const mainSource = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(mainSource).toContain("options.prepareHarness && gridParityPrompt(project?.developmentGoal) && !isDraft");
    expect(mainSource).toContain("EDITOR_GRID_PARITY_REQUIRES_BLANK_DRAFT");
  });
});
