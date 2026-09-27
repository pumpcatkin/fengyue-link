import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createBundledGridCard,
  createEditedGameCard,
  decomposeGameCard,
  validateGameCard
} = require("../electron/online-world-card.cjs");
const {
  DEFAULT_AGENT_COMPONENTS,
  createEditorProject,
  createBlankEditorProject,
  loadEditorProjects,
  normalizeEditorProject,
  normalizeAgentSynthesis,
  applyAgentSynthesis,
  parseAgentAnswer,
  saveEditorProjects
} = require("../electron/online-game-editor.cjs");
const { rankEditorModels } = require("../electron/auto-model-router.cjs");

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
  });

  it("creates a local-only blank draft without a companion work", () => {
    const project = createBlankEditorProject({
      origin: "https://staging.aiero.cc",
      accountId: "39404f0e-7678-45a1-86c6-9a21116bacbd"
    });
    expect(project.isDraft).toBe(true);
    expect(project.card.companion.workId).toBe("");
    expect(project.card.companion.authorAccountId).toBe("39404f0e-7678-45a1-86c6-9a21116bacbd");
    expect(project.program.html).toContain("未命名游戏");
    expect(project.agents.every((item: any) => item.workId === "")).toBe(true);
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
