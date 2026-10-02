"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  GRID_COMPANION_COPY,
  GRID_GAME_TITLE,
  builtInGridProgram,
  createBundledGridCard,
  decomposeGameCard,
  normalizeProgramText
} = require("./online-world-card.cjs");
const { GRID_GAME_ID, applyIntent, createWorld } = require("./grid-world-game.cjs");
const { canonicalJson, FYOW_SCHEMAS } = require("./online-world-protocol.cjs");
const { DEFAULT_EDITOR_PROGRAM } = require("./online-game-editor.cjs");

const GRID_PARITY_SCHEMA = "fyow.editor-grid-parity/1";
const GRID_PARITY_TEMPLATE_VERSION = 1;

const GRID_PARITY_INTENTS = Object.freeze([
  "join",
  "recover-defeated-player",
  "dismiss-battle-report",
  "confirm-general-discovery",
  "decline-general-discovery",
  "start-mining",
  "stop-mining",
  "train",
  "cultivate-player",
  "power-train",
  "cultivate-general",
  "reorder-carried-generals",
  "list-general",
  "cancel-market-listing",
  "buy-market-general",
  "cancel-march",
  "deploy-soldiers",
  "gather-march",
  "march",
  "deploy-general",
  "recall-general",
  "take-general",
  "talk-general",
  "record-general-dialogue",
  "surrender-general",
  "execute-captive",
  "edit-general-appearance",
  "apply-general-appearance",
  "grant-general"
]);

const GRID_PARITY_MODEL_TASKS = Object.freeze([
  "general.generate",
  "player.profile-context",
  "general.dialogue",
  "general.captive-dialogue",
  "general.memory.update",
  "general.letter",
  "general.appearance-edit"
]);

const GRID_PARITY_ADMIN_COMMANDS = Object.freeze([
  "open-server",
  "migrate-server",
  "scatter-treasures",
  "balance-update",
  "simulate-player-intent",
  "player-reset",
  "player-ban",
  "player-unban"
]);

const GRID_PARITY_SERVICE_METHODS = Object.freeze([
  "initialize",
  "submitIntent",
  "applyLocalIntent",
  "submitWorldChat",
  "readWorldChatHistory",
  "sendDirect",
  "receiveDirectWakes",
  "administer",
  "publishSnapshot",
  "reconnect",
  "syncNow",
  "exportMigrationDraft",
  "completeMigrationDraft",
  "requestStructuredModel"
]);

const GRID_PARITY_UI_MARKERS = Object.freeze([
  "id=\"map\"",
  "id=\"world-chat-form\"",
  "id=\"general-conversations\"",
  "id=\"market-open\"",
  "id=\"battle-report-button\"",
  "id=\"owner-command-modal\"",
  "id=\"model-usage-log\""
]);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceFile = name => fs.readFileSync(path.join(__dirname, name), "utf8");
const sourceHas = (source, token) => source.includes(token);

function gridParityPrompt(value) {
  const goal = String(value || "").trim();
  if (!goal || !goal.includes("猎艳疆土")) return false;
  const creation = "新建|创建|制作|生成|做出|复刻|还原|复制|克隆";
  const gameTarget = "新游戏|游戏卡|一款游戏|一个游戏";
  const negatedCreation = new RegExp(`(?:不要|别|禁止|避免|无需|不需要|并非|不是).{0,24}(?:${creation}|${gameTarget})`).test(goal)
    || new RegExp(`(?:${creation}).{0,12}(?:不要|别|禁止|避免|无需|不需要)`).test(goal);
  if (negatedCreation) return false;
  const asksForCreation = new RegExp(`(?:${creation}).{0,48}(?:${gameTarget})`).test(goal)
    || new RegExp(`(?:${gameTarget}).{0,24}(?:${creation})`).test(goal);
  const asksForParity = /(功能.{0,8}(一致|相同|完整|等价)|完整功能|同功能|同款|等价|一样|一模一样|完全一致|完整复刻|完整还原)/.test(goal);
  return asksForCreation && asksForParity;
}

function normalizedOrigin(value) {
  try { return new URL(String(value || "")).origin; } catch { return String(value || "").replace(/\/+$/, ""); }
}

function gridParityDraftSourceChecks(project, { libraryId = "", accountId = "", origin = "" } = {}) {
  const draftId = String(project?.draftId || "");
  const cardId = String(project?.card?.cardId || "");
  const gameId = String(project?.card?.gameId || "");
  const configuration = project?.configuration || {};
  const expectedOrigin = normalizedOrigin(origin);
  const actualOrigin = normalizedOrigin(project?.card?.companion?.origin);
  return {
    draftLibraryKey: Boolean(draftId) && String(libraryId || "") === `draft::${draftId}`,
    isDraft: project?.isDraft === true,
    draftId: /^draft-[a-f0-9]{16}$/i.test(draftId),
    localCardId: /^cc\.aiero\.fyow\.local\.[a-f0-9]{16}$/i.test(cardId),
    localGameId: /^fyow-local-[a-f0-9]{16}$/i.test(gameId),
    unpublished: String(project?.card?.companion?.workId || "") === "" && Number(project?.card?.version || 0) === 0,
    noPendingPublication: !String(project?.pendingPublication?.workId || ""),
    currentAuthor: Boolean(accountId) && String(project?.card?.companion?.authorAccountId || "") === String(accountId),
    currentOrigin: Boolean(expectedOrigin) && actualOrigin === expectedOrigin,
    blankProgram: normalizeProgramText(project?.program?.html || "").trim() === normalizeProgramText(DEFAULT_EDITOR_PROGRAM).trim(),
    blankPrompts: ["pre_text", "pre_prompt", "post_text"].every(key => String(configuration[key] || "") === "")
      && Array.isArray(configuration.world_book) && configuration.world_book.length === 0
  };
}

function assertGridParityDraftSource(project, options = {}) {
  const checks = gridParityDraftSourceChecks(project, options);
  const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key);
  if (missing.length) {
    const error = new Error("猎艳疆土等价模板只能用于刚创建且尚未编辑、尚未发布的本地新游戏草稿");
    error.code = "EDITOR_GRID_PARITY_REQUIRES_BLANK_DRAFT";
    error.checks = checks;
    error.missing = missing;
    throw error;
  }
  return checks;
}

function gridParityTitle(goal, fallback = "") {
  const text = String(goal || "");
  const named = text.match(/(?:游戏)?(?:名为|叫作|叫做|标题为)\s*[“\"「『]?([^”\"」』，。；;\n]{2,40})/);
  if (named?.[1]) return named[1].trim();
  const cleanFallback = String(fallback || "").trim();
  if (cleanFallback && !/^(未命名游戏|猎艳疆土)$/.test(cleanFallback)) return cleanFallback.slice(0, 80);
  return "猎艳疆土同功能新游戏";
}

function sourceCapabilityEvidence() {
  const rules = sourceFile("grid-world-game.cjs");
  const service = sourceFile("online-world-service.cjs");
  const protocol = sourceFile("online-world-protocol.cjs");
  const ui = sourceFile(path.join("desktop", "online-world", "grid-conquest", "index.html"));
  const uiLogic = sourceFile(path.join("desktop", "online-world", "grid-conquest", "game.js"));
  const intentChecks = Object.fromEntries(GRID_PARITY_INTENTS.map(type => [type, sourceHas(rules, `type === "${type}"`)]));
  const serviceChecks = Object.fromEntries(GRID_PARITY_SERVICE_METHODS.map(method => [method,
    new RegExp(`(?:async\\s+)?${method}\\s*\\(`).test(service)]));
  const schemaChecks = Object.fromEntries(Object.entries(FYOW_SCHEMAS).map(([name, schema]) => [name,
    sourceHas(protocol, `${name}: "${schema}"`)]));
  const adminChecks = Object.fromEntries(GRID_PARITY_ADMIN_COMMANDS.map(type => [type,
    sourceHas(uiLogic, `type: "${type}"`) || sourceHas(service, `type === "${type}"`)
      || sourceHas(uiLogic, `"${type}"`) || sourceHas(service, `"${type}"`)]));
  const uiChecks = Object.fromEntries(GRID_PARITY_UI_MARKERS.map(marker => [marker, sourceHas(ui, marker)]));
  return {
    sources: {
      rulesSha256: sha256(rules),
      serviceSha256: sha256(service),
      protocolSha256: sha256(protocol),
      uiSha256: sha256(ui),
      uiLogicSha256: sha256(uiLogic)
    },
    intentChecks,
    serviceChecks,
    schemaChecks,
    adminChecks,
    uiChecks
  };
}

function capability(name, checks, description) {
  const entries = Object.entries(checks);
  const missing = entries.filter(([, passed]) => !passed).map(([key]) => key);
  return { name, description, passed: missing.length === 0, checks, missing };
}

function gridParityCapabilityReport(project, options = {}) {
  const canonical = decomposeGameCard(createBundledGridCard());
  const canonicalProgram = normalizeProgramText(canonical.program.html).trim();
  const actualProgram = normalizeProgramText(project?.program?.html || "").trim();
  const configuration = project?.configuration || {};
  const worldBook = Array.isArray(configuration.world_book) ? configuration.world_book : [];
  const worldBookText = worldBook.map(item => `${item?.key || ""}\n${item?.value || ""}`).join("\n");
  const evidence = sourceCapabilityEvidence();
  const draftId = String(project?.draftId || "");
  const workId = String(project?.card?.companion?.workId || "");
  const expectedOrigin = normalizedOrigin(options.origin);
  const actualOrigin = normalizedOrigin(project?.card?.companion?.origin);
  const identityChecks = {
    isDraft: project?.isDraft === true,
    draftId: /^draft-[a-f0-9]{16}$/i.test(draftId),
    localCardId: /^cc\.aiero\.fyow\.local\.[a-f0-9]{16}$/i.test(String(project?.card?.cardId || "")),
    emptyWorkId: workId === "",
    noPendingPublication: !String(project?.pendingPublication?.workId || ""),
    currentAuthor: Boolean(options.accountId) && String(project?.card?.companion?.authorAccountId || "") === String(options.accountId),
    currentOrigin: Boolean(expectedOrigin) && actualOrigin === expectedOrigin,
    expectedDraftId: !options.draftId || draftId === String(options.draftId),
    expectedCardId: !options.cardId || String(project?.card?.cardId || "") === String(options.cardId)
  };
  const programChecks = {
    gameId: String(project?.card?.gameId || "") === GRID_GAME_ID,
    exactProgram: actualProgram === canonicalProgram,
    programDigest: project?.card?.companion?.workId
      ? /^[a-f0-9]{64}$/.test(String(project?.program?.digest || ""))
      : String(project?.program?.digest || "") === String(canonical.program.digest || ""),
    gridSource: actualProgram.includes('source: "fyow-grid-conquest"') || actualProgram.includes('source:"fyow-grid-conquest"'),
    hostProtocol: actualProgram.includes('"fyow-host/1"'),
    notStandalone: !actualProgram.includes('name="fyow-runtime" content="standalone/1"')
  };
  const promptChecks = {
    preText: String(configuration.pre_text || "") === String(canonical.configuration.pre_text || ""),
    prePrompt: String(configuration.pre_prompt || "") === String(canonical.configuration.pre_prompt || ""),
    postText: String(configuration.post_text || "") === String(canonical.configuration.post_text || ""),
    worldBook: canonicalJson(worldBook) === canonicalJson(canonical.configuration.world_book || [])
  };
  const modelChecks = Object.fromEntries(GRID_PARITY_MODEL_TASKS.map(task => [task,
    worldBookText.includes(`[[FYOW:TASK:${task}:v1]]`)]));
  const ruleChecks = {
    map64x64: sourceHas(sourceFile("grid-world-game.cjs"), "const GRID_SIZE = 64"),
    deterministicCells: sourceHas(sourceFile("grid-world-game.cjs"), "function staticCell"),
    timedSettlement: sourceHas(sourceFile("grid-world-game.cjs"), "function settleWorld"),
    battleReports: sourceHas(sourceFile("grid-world-game.cjs"), "function recordBattleReport"),
    generalMarket: sourceHas(sourceFile("grid-world-game.cjs"), "marketListings"),
    treasureMaterials: sourceHas(sourceFile("grid-world-game.cjs"), "function scatterTreasures")
  };
  const communicationChecks = {
    worldChat: evidence.serviceChecks.submitWorldChat && evidence.schemaChecks.worldChat,
    encryptedDirect: evidence.serviceChecks.sendDirect && evidence.schemaChecks.direct && evidence.schemaChecks.directWake,
    signedLedger: evidence.schemaChecks.control && evidence.schemaChecks.snapshot && evidence.schemaChecks.mapDelta,
    chunkedRecords: sourceHas(sourceFile("online-world-protocol.cjs"), "function encodeCommentRecord"),
    reconnect: evidence.serviceChecks.reconnect && evidence.serviceChecks.syncNow,
    migration: evidence.serviceChecks.exportMigrationDraft && evidence.serviceChecks.completeMigrationDraft
  };
  const capabilities = [
    capability("identity", identityChecks, "保持本地新游戏草稿身份，并与当前账号和平台域名绑定"),
    capability("program", programChecks, "运行与官方疆土模板完全相同的前端程序及宿主协议"),
    capability("configuration", promptChecks, "复制结构化任务提示词与全部世界书契约"),
    capability("model-tasks", modelChecks, "覆盖人物生成、画像、对话、记忆、书信和外观编辑"),
    capability("rules", ruleChecks, "覆盖地图、经济、时间结算、战斗、市场和宝物规则"),
    capability("intents", evidence.intentChecks, "覆盖玩家可执行的全部疆土规则意图"),
    capability("service", evidence.serviceChecks, "覆盖宿主初始化、同步、模型、社交、管理和迁移服务"),
    capability("protocol", evidence.schemaChecks, "覆盖签名控制、快照、地图增量、私密仓库、聊天和迁移记录"),
    capability("communication", communicationChecks, "覆盖公共聊天、加密书信、签名账本、重连和迁移"),
    capability("administration", evidence.adminChecks, "覆盖开服、平衡、宝物、玩家管理和服务器迁移"),
    capability("interface", evidence.uiChecks, "覆盖地图、通讯、将领、市场、战报、管理和积分展示界面")
  ];
  const missing = capabilities.flatMap(item => item.missing.map(check => `${item.name}:${check}`));
  return {
    schema: GRID_PARITY_SCHEMA,
    templateVersion: GRID_PARITY_TEMPLATE_VERSION,
    gameId: GRID_GAME_ID,
    passed: missing.length === 0,
    missing,
    capabilities,
    sourceProof: evidence.sources,
    programDigest: canonical.program.digest,
    checkedAt: Date.now()
  };
}

function assertGridParityProject(project, options = {}) {
  const report = gridParityCapabilityReport(project, options);
  if (!report.passed) {
    const error = new Error(`猎艳疆土等价能力验证失败：${report.missing.join("、")}`);
    error.code = "EDITOR_GRID_PARITY_FAILED";
    error.report = report;
    throw error;
  }
  return report;
}

function gridParityTests() {
  return {
    schema: "fyow.grid-parity-tests/1",
    requiredSuites: [
      "grid-world-game",
      "online-world-service",
      "online-world-migration-regression",
      "online-world-card",
      "online-world-protocol"
    ],
    capabilityGroups: [
      "identity", "program", "configuration", "model-tasks", "rules", "intents",
      "service", "protocol", "communication", "administration", "interface"
    ]
  };
}

function instantiateGridParityProject(original, goal, options = {}) {
  if (!gridParityPrompt(goal)) throw new Error("当前提示词没有明确要求创建与猎艳疆土完整功能一致的新游戏");
  const source = clone(original || {});
  assertGridParityDraftSource(source, options);
  const canonical = decomposeGameCard(createBundledGridCard());
  const title = gridParityTitle(goal, options.title || source.card?.title);
  const next = {
    ...canonical,
    draftId: source.draftId,
    isDraft: true,
    revision: Number(source.revision || 0),
    updatedAt: Date.now(),
    pendingPublication: source.pendingPublication || null,
    publication: clone(source.publication),
    developmentSettings: clone(source.developmentSettings),
    editorSessions: clone(source.editorSessions),
    card: {
      ...canonical.card,
      cardId: String(source.card?.cardId || `cc.aiero.fyow.local.${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`),
      gameId: GRID_GAME_ID,
      title,
      version: 0,
      exportedAt: null,
      companion: {
        ...canonical.card.companion,
        origin: String(source.card?.companion?.origin || options.origin || canonical.card.companion.origin),
        workId: "",
        authorAccountId: String(source.card?.companion?.authorAccountId || options.accountId || ""),
        name: title,
        summary: String(options.summary || canonical.card.companion.summary),
        language: "zh-Hans"
      }
    },
    program: clone(canonical.program),
    configuration: {
      ...clone(canonical.configuration),
      app: {
        ...clone(canonical.configuration.app),
        id: "",
        name: title,
        summary: String(options.summary || canonical.configuration.app.summary)
      }
    },
    validation: null,
    harness: {
      schema: "fyow.harness/2",
      status: "completed",
      goal: String(goal),
      mode: "deterministic-grid-parity-template",
      tests: gridParityTests(),
      models: [],
      events: [{
        at: Date.now(),
        kind: "tool-result",
        stage: "completed",
        tool: "instantiate-grid-parity-template",
        summary: "已从版本化猎艳疆土模板实例化完整规则、联机协议、模型任务和界面"
      }],
      finishedAt: Date.now()
    }
  };
  const report = assertGridParityProject(next, {
    accountId: options.accountId,
    origin: options.origin,
    draftId: source.draftId,
    cardId: source.card?.cardId
  });
  const { fingerprint, projectFiles } = require("./game-harness.cjs");
  const evidence = {
    passed: true,
    mode: "deterministic-grid-parity-template",
    fingerprint: fingerprint(projectFiles(next)),
    checkedAt: Date.now(),
    parity: report
  };
  next.harness.evidence = evidence;
  next.harness.review = {
    approved: true,
    mode: "deterministic-template-verifier",
    fingerprint: evidence.fingerprint,
    summary: "程序、规则、协议、模型任务和宿主能力均来自当前版本已回归的猎艳疆土模板。"
  };
  next.parity = report;
  return next;
}

function smokeGridParityRules() {
  const world = createWorld({ seed: "editor-grid-parity", seasonId: "editor-grid-parity-season", startedAt: 1_000 });
  const result = applyIntent(world, {
    type: "join",
    displayName: "验收玩家",
    orientation: "any",
    characterProfileId: "profile-editor-parity",
    characterTags: [{ name: "策略", annotation: "重视资源与行军" }],
    initialGeneralWish: "一名可靠且擅长统筹的将领",
    idempotencyKey: "editor-grid-parity-join"
  }, { actorAccountId: "editor-grid-parity-account", actorAccountName: "验收账号", now: 2_000 });
  if (!result.state.players["editor-grid-parity-account"] || !result.effects.some(item => item.type === "general-generation-request")) {
    throw new Error("猎艳疆土规则烟雾验收未生成玩家与初始将领任务");
  }
  return { joined: true, effects: result.effects.map(item => item.type), revision: result.state.revision };
}

module.exports = {
  GRID_PARITY_SCHEMA,
  GRID_PARITY_TEMPLATE_VERSION,
  GRID_PARITY_INTENTS,
  GRID_PARITY_MODEL_TASKS,
  GRID_PARITY_ADMIN_COMMANDS,
  GRID_PARITY_SERVICE_METHODS,
  GRID_PARITY_UI_MARKERS,
  gridParityPrompt,
  gridParityTitle,
  gridParityDraftSourceChecks,
  assertGridParityDraftSource,
  gridParityCapabilityReport,
  assertGridParityProject,
  gridParityTests,
  instantiateGridParityProject,
  smokeGridParityRules
};
