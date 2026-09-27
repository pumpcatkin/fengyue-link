"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJsonSync, readJsonWithBackupSync } = require("./runtime-utils.cjs");
const { decomposeGameCard } = require("./online-world-card.cjs");

const EDITOR_SCHEMA = "fyow.game-card-editor/1";
const EDITOR_PROJECTS_SCHEMA = "fyow.game-card-editor-projects/1";

const DEFAULT_AGENT_COMPONENTS = Object.freeze([
  { id: "architect", label: "玩法架构师", role: "玩法目标、状态和事件设计", workId: "", enabled: true },
  { id: "prompt-designer", label: "提示词设计师", role: "任务提示词、世界书和结构化输出", workId: "", enabled: true },
  { id: "ux-designer", label: "界面设计师", role: "卡片前端布局、交互和玩家反馈", workId: "", enabled: true },
  { id: "verifier", label: "验证审查员", role: "协议、权限、体积和回退路径审查", workId: "", enabled: true }
]);

const DEFAULT_EDITOR_PROGRAM = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>未命名游戏</title></head>
  <body><main><h1>未命名游戏</h1><p>从这里开始设计你的游戏卡。</p></main></body>
</html>`;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function editorProjectPath(userDataPath, profileId) {
  return path.join(userDataPath, "online-world", "editor-projects", `${String(profileId || "default").replace(/[^a-zA-Z0-9_-]/g, "-")}.json`);
}

function normalizeAgentComponents(value, fallbackWorkId = "") {
  const source = Array.isArray(value) ? value : [];
  const byId = new Map(source.map(item => [String(item?.id || ""), item]));
  return DEFAULT_AGENT_COMPONENTS.map(defaultItem => {
    const item = byId.get(defaultItem.id) || {};
    return {
      ...defaultItem,
      label: String(item.label || defaultItem.label).slice(0, 80),
      role: String(item.role || defaultItem.role).slice(0, 160),
      workId: String(fallbackWorkId || "").trim().slice(0, 120),
      enabled: item.enabled !== false
    };
  });
}

function normalizeEditorProject(value, fallbackWorkId = "") {
  const project = value && typeof value === "object" ? clone(value) : {};
  project.schema = EDITOR_SCHEMA;
  project.agents = normalizeAgentComponents(project.agents, fallbackWorkId);
  project.updatedAt = Number(project.updatedAt || Date.now());
  return project;
}

function loadEditorProjects(file) {
  if (!file || !fs.existsSync(file)) return { schema: EDITOR_PROJECTS_SCHEMA, projects: {} };
  try {
    const root = readJsonWithBackupSync(fs, file, value => value?.schema === EDITOR_PROJECTS_SCHEMA && value.projects && typeof value.projects === "object").value;
    return root?.schema === EDITOR_PROJECTS_SCHEMA ? root : { schema: EDITOR_PROJECTS_SCHEMA, projects: {} };
  } catch {
    return { schema: EDITOR_PROJECTS_SCHEMA, projects: {} };
  }
}

function saveEditorProjects(file, projects) {
  const normalized = {};
  for (const [key, value] of Object.entries(projects || {})) {
    if (!key) continue;
    normalized[key] = normalizeEditorProject(value);
  }
  atomicWriteJsonSync(fs, file, { schema: EDITOR_PROJECTS_SCHEMA, projects: normalized }, { pretty: true });
}

function createEditorProject(card) {
  const project = decomposeGameCard(card);
  project.agents = normalizeAgentComponents(project.agents, card?.companion?.workId || "");
  project.agentDraft = null;
  project.updatedAt = Date.now();
  return project;
}

function createBlankEditorProject({ origin = "", accountId = "", title = "未命名游戏" } = {}) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const cardId = `cc.aiero.fyow.local.${suffix}`;
  const gameId = `fyow-local-${suffix}`;
  const name = String(title || "未命名游戏").slice(0, 80);
  return normalizeEditorProject({
    schema: EDITOR_SCHEMA,
    draftId: `draft-${suffix}`,
    isDraft: true,
    card: {
      cardId,
      gameId,
      title: name,
      version: 0,
      exportedAt: null,
      companion: {
        origin: String(origin || ""),
        workId: "",
        authorAccountId: String(accountId || ""),
        name,
        summary: "",
        language: "zh-Hans"
      }
    },
    program: {
      format: "fyow.program/1",
      apiVersion: 1,
      digest: "",
      html: DEFAULT_EDITOR_PROGRAM
    },
    configuration: {
      app: {
        id: "",
        name,
        description: "",
        summary: "",
        language: "zh-Hans"
      },
      pre_text: "",
      pre_prompt: "",
      post_text: "",
      world_book: []
    },
    validation: null,
    agentDraft: null,
    workSelection: "create"
  });
}

function parseAgentAnswer(answer) {
  const text = String(answer || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === "object" ? value : { text };
  } catch {
    return { text };
  }
}

function normalizeAgentSynthesis(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const candidate = source.configurationPatch && typeof source.configurationPatch === "object"
    ? source.configurationPatch
    : {};
  const patch = {};
  const app = candidate.app && typeof candidate.app === "object" ? candidate.app : {};
  if (Object.hasOwn(app, "name")) patch.app = { name: String(app.name || "").slice(0, 120) };
  if (Object.hasOwn(app, "summary")) {
    patch.app ||= {};
    patch.app.summary = String(app.summary || "").slice(0, 4000);
  }
  for (const key of ["pre_text", "pre_prompt", "post_text"]) {
    if (Object.hasOwn(candidate, key)) patch[key] = String(candidate[key] || "").slice(0, 12000);
  }
  if (Array.isArray(candidate.world_book)) patch.world_book = clone(candidate.world_book).slice(0, 200);
  return {
    schema: "fyow.editor-synthesis/1",
    accepted: Boolean(Object.keys(patch).length),
    summary: String(source.summary || source.decision || "").slice(0, 4000),
    configurationPatch: patch,
    validation: source.validation && typeof source.validation === "object" ? clone(source.validation) : {},
    questions: Array.isArray(source.questions) ? source.questions.map(item => String(item)).slice(0, 20) : [],
    raw: Object.keys(patch).length || source.summary || source.decision ? null : clone(value)
  };
}

function applyAgentSynthesis(project, synthesis) {
  const next = clone(project) || {};
  const configuration = next.configuration && typeof next.configuration === "object" ? next.configuration : {};
  const patch = synthesis?.configurationPatch && typeof synthesis.configurationPatch === "object"
    ? synthesis.configurationPatch
    : {};
  configuration.app = { ...(configuration.app || {}), ...(patch.app || {}) };
  for (const key of ["pre_text", "pre_prompt", "post_text", "world_book"]) {
    if (Object.hasOwn(patch, key)) configuration[key] = clone(patch[key]);
  }
  next.configuration = configuration;
  return next;
}

function agentJobId() {
  return crypto.randomUUID();
}

module.exports = {
  EDITOR_SCHEMA,
  EDITOR_PROJECTS_SCHEMA,
  DEFAULT_AGENT_COMPONENTS,
  editorProjectPath,
  normalizeAgentComponents,
  normalizeEditorProject,
  loadEditorProjects,
  saveEditorProjects,
  createEditorProject,
  createBlankEditorProject,
  DEFAULT_EDITOR_PROGRAM,
  parseAgentAnswer,
  normalizeAgentSynthesis,
  applyAgentSynthesis,
  agentJobId
};
