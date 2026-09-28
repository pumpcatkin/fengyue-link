"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJsonSync, readJsonWithBackupSync } = require("./runtime-utils.cjs");
const { decomposeGameCard } = require("./online-world-card.cjs");
const { injectSandboxCsp } = require("./online-world-runtime.cjs");

const EDITOR_SCHEMA = "fyow.game-card-editor/1";
const EDITOR_PROJECTS_SCHEMA = "fyow.game-card-editor-projects/1";

const DEFAULT_AGENT_COMPONENTS = Object.freeze([
  { id: "architect", label: "世界架构师", role: "把目标拆成可验证的循环、状态机、事件和任务契约", workId: "", enabled: true },
  { id: "prompt-designer", label: "结构化提示词师", role: "设计前置词、后置词、世界书条目和严格 JSON 输出约束", workId: "", enabled: true },
  { id: "runtime-network-engineer", label: "运行时通信工程师", role: "审查 fyow-host/1 协议、请求去重、同步节奏、断线恢复和沙箱边界", workId: "", enabled: true },
  { id: "ux-designer", label: "玩家体验设计师", role: "设计单文件卡片的布局、即时反馈、长耗时行动和错误恢复", workId: "", enabled: true },
  { id: "verifier", label: "卡包验证审查员", role: "验证程序可玩性、卡包摘要、配置回读、权限和发布前回退路径", workId: "", enabled: true }
]);

const ONLINE_WORLD_EDITOR_PLAYBOOK = Object.freeze({
  source: "猎艳疆土运行卡复盘",
  gameModel: [
    "这是一个由宿主持有世界状态的长期运行策略卡：玩家状态、地图、行动队列、模型任务和社交记录都以宿主快照为准。",
    "卡片前端只负责展示、输入和本地时间显示；不要在卡片内复制世界状态、伪造积分、直接写评论或实现第二套服务器。",
    "长耗时行动显示服务端 finishAt/serverNow 的倒计时，前端每 1000ms 更新一次视觉倒计时即可；这个定时器不是网络轮询。宿主公共记录轮询基准为 5000ms，失败退避到最多 60000ms，并加入最多 1200ms 抖动。"
  ],
  hostProtocol: [
    "使用 source=fyow-grid-conquest、protocol=fyow-host/1 的 postMessage；请求通过 parent.postMessage，结果通过宿主回发。",
    "需要结果的请求必须带 crypto.randomUUID() 生成的 UUID requestId；intent 还要带随机 idempotencyKey，并按 intent:<type> 做并发去重，避免重复扣费或重复行动。",
    "标准消息类型包括 ready、state、result、error、intent、sync、reconnect、preferences、direct、confirm；未知类型不应被前端自行执行。",
    "连接异常时优先显示本地已保存/待同步状态，再由用户触发 sync 或 reconnect；同步请求可等待 120 秒，不能用高频自动重试压垮宿主。定向消息与世界聊天各按 60 秒窗口限流，分别最多 12 次；429 触发至少 30 秒、最多 10 分钟的持久冷却。"
  ],
  promptPractice: [
    "像猎艳疆土一样用 [[FYOW:TASK:<name>:v1]] 路由任务；输入 JSON 只作数据，任务条目负责唯一输出 Schema。",
    "世界书条目应分别描述输入事实优先级、允许补全范围、字段长度、枚举值、内部标识禁止项和失败时的宿主处理。",
    "前置词建立世界观和全局规则，世界书建立单任务契约，后置词再次锁定 JSON 顶层字段；三者不要互相覆盖。"
  ],
  qualityGates: [
    "保存前必须能从 app.description 解析 FYOW-PROGRAM/1，gameId、程序摘要、配置摘要和整包摘要全部重新计算并通过校验。",
    "保存后要用回读配置重建卡片并做可玩性检查；任何程序信封缺失、gameId 不匹配或摘要变化都应阻止落盘。",
    "Agent 只能提出 app.name、app.summary、pre_text、pre_prompt、post_text、world_book 的配置补丁，不能修改程序、作品编号、权限或宿主协议。"
  ]
});

const DEFAULT_EDITOR_PROGRAM = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>未命名游戏</title>
    <style>
      :root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#101820;color:#e8f1f5}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;padding:28px;background:#101820}
      main{max-width:720px;margin:0 auto;border:1px solid #385266;border-radius:8px;background:#172633;padding:24px;box-shadow:0 18px 42px #0005}
      h1{margin:0 0 8px;font-size:26px}p{color:#a9c0ce;line-height:1.7}#status{color:#8ee0b7;font-size:13px}
      button{border:1px solid #5b8ca8;border-radius:4px;background:#23475d;color:#f4fbff;padding:9px 14px;cursor:pointer}button+button{margin-left:8px}
      pre{max-height:260px;overflow:auto;border:1px solid #304756;background:#0d151c;padding:12px;color:#bdd2de;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap}
    </style>
  </head>
  <body>
    <main>
      <h1 id="title">未命名游戏</h1>
      <p id="status">正在连接风月宿主…</p>
      <button id="sync" type="button">刷新世界状态</button><button id="library" type="button">返回游戏库</button>
      <pre id="snapshot">等待宿主状态…</pre>
    </main>
    <script>
      const SOURCE="fyow-grid-conquest";const PROTOCOL="fyow-host/1";
      const statusNode=document.querySelector("#status");const snapshotNode=document.querySelector("#snapshot");
      const titleNode=document.querySelector("#title");const syncButton=document.querySelector("#sync");let pendingRequest=null;
      function finishRequest(){clearTimeout(pendingRequest?.timer);pendingRequest=null;syncButton.disabled=false;}
      function send(type,data={},expectResult=false){
        if(expectResult&&pendingRequest)return;
        const message={source:SOURCE,protocol:PROTOCOL,type,...data};
        if(expectResult){
          message.requestId=crypto.randomUUID();syncButton.disabled=true;statusNode.textContent="正在同步…";
          pendingRequest={id:message.requestId,timer:setTimeout(()=>{finishRequest();statusNode.textContent="同步超时，请稍后重试";},120000)};
        }
        parent.postMessage(message,"*");
      }
      function renderState(state){const card=state?.card||{};const world=state?.world||{};const playerCount=Object.keys(world.players||{}).length;titleNode.textContent=card.title||card.workName||"未命名游戏";statusNode.textContent=\`已连接 · \${playerCount} 名玩家 · \${state?.status||"等待世界状态"}\`;snapshotNode.textContent=JSON.stringify({status:state?.status,initialized:state?.initialized,playerCount,serverNow:state?.serverNow||Date.now()},null,2);}
      window.addEventListener("message",event=>{
        if(event.source!==parent||event.data?.source!=="fengyue-host"||event.data?.protocol!==PROTOCOL)return;
        if(event.data.type==="state")renderState(event.data.state);
        if(["error","result"].includes(event.data.type)&&pendingRequest?.id===event.data.requestId){
          finishRequest();
          statusNode.textContent=event.data.type==="error"?\`宿主提示：\${event.data.message||"请求失败"}\`:"宿主已返回最新结果";
        }
      });
      syncButton.addEventListener("click",()=>send("sync",{},true));
      document.querySelector("#library").addEventListener("click",()=>send("library"));
      send("ready");
    </script>
  </body>
</html>`;

const LEGACY_DEFAULT_EDITOR_PROGRAM = `<!doctype html>
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
  const configuration = project.configuration && typeof project.configuration === "object" && !Array.isArray(project.configuration)
    ? project.configuration
    : {};
  configuration.app = configuration.app && typeof configuration.app === "object" && !Array.isArray(configuration.app)
    ? configuration.app
    : {};
  for (const key of ["pre_text", "pre_prompt", "post_text"]) {
    configuration[key] = String(configuration[key] ?? "");
  }
  configuration.world_book = Array.isArray(configuration.world_book) ? configuration.world_book : [];
  project.configuration = configuration;
  const programHtml = String(project.program?.html || "").replace(/\r\n?/g, "\n").trim();
  if (programHtml === LEGACY_DEFAULT_EDITOR_PROGRAM.trim()
    || programHtml === injectSandboxCsp(LEGACY_DEFAULT_EDITOR_PROGRAM).trim()) {
    project.program = { ...(project.program || {}), html: DEFAULT_EDITOR_PROGRAM };
  }
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

function parseStructuredAgentAnswer(answer, label = "编辑器 Agent", { synthesis = false } = {}) {
  const text = String(answer || "").trim();
  const parsed = parseAgentAnswer(answer);
  const plainTextFallback = Object.keys(parsed).length === 1
    && Object.hasOwn(parsed, "text")
    && String(parsed.text || "").trim() === text;
  if (!text || plainTextFallback || Array.isArray(parsed) || !Object.keys(parsed).length) {
    throw new Error(`${label} 未返回有效 JSON 对象`);
  }
  if (synthesis && (typeof parsed.validation?.approved !== "boolean"
    || !parsed.configurationPatch || typeof parsed.configurationPatch !== "object"
    || Array.isArray(parsed.configurationPatch))) {
    throw new Error(`${label} 缺少配置补丁或明确的审查结论`);
  }
  return parsed;
}

function normalizeAgentSynthesis(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const candidate = source.configurationPatch && typeof source.configurationPatch === "object"
    ? source.configurationPatch
    : {};
  const patch = {};
  const app = candidate.app && typeof candidate.app === "object" ? candidate.app : {};
  if (Object.hasOwn(app, "name") && String(app.name || "").trim()) patch.app = { name: String(app.name).slice(0, 120) };
  if (Object.hasOwn(app, "summary") && String(app.summary || "").trim()) {
    patch.app ||= {};
    patch.app.summary = String(app.summary).slice(0, 4000);
  }
  for (const key of ["pre_text", "pre_prompt", "post_text"]) {
    if (Object.hasOwn(candidate, key) && String(candidate[key] || "").trim()) patch[key] = String(candidate[key]).slice(0, 12000);
  }
  if (Array.isArray(candidate.world_book) && candidate.world_book.length) patch.world_book = clone(candidate.world_book).slice(0, 200);
  const validation = source.validation && typeof source.validation === "object" ? clone(source.validation) : {};
  const approved = validation.approved !== false && source.approved !== false;
  const hasPatch = Boolean(Object.keys(patch).length);
  return {
    schema: "fyow.editor-synthesis/1",
    approved,
    accepted: approved && hasPatch,
    summary: String(source.summary || source.decision || "").slice(0, 4000),
    configurationPatch: patch,
    validation,
    questions: Array.isArray(source.questions) ? source.questions.map(item => String(item)).slice(0, 20) : [],
    raw: hasPatch || source.summary || source.decision ? null : clone(value)
  };
}

function applyAgentSynthesis(project, synthesis) {
  const next = clone(project) || {};
  if (synthesis?.approved === false || synthesis?.validation?.approved === false) return next;
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
  ONLINE_WORLD_EDITOR_PLAYBOOK,
  editorProjectPath,
  normalizeAgentComponents,
  normalizeEditorProject,
  loadEditorProjects,
  saveEditorProjects,
  createEditorProject,
  createBlankEditorProject,
  DEFAULT_EDITOR_PROGRAM,
  parseAgentAnswer,
  parseStructuredAgentAnswer,
  normalizeAgentSynthesis,
  applyAgentSynthesis,
  agentJobId
};
