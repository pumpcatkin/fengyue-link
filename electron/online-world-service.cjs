const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJsonSync, readJsonWithBackupSync } = require("./runtime-utils.cjs");
const {
  FYOW_SCHEMAS,
  canonicalJson,
  sha256,
  encodeCommentRecord,
  assembleCommentRecords,
  extractCommentItems,
  commentIsFromAuthor,
  historyPageDecision,
  signRecord,
  verifySignedRecord,
  createResetDirective
} = require("./online-world-protocol.cjs");
const { sealJson, openSealedJson, publicIdentity } = require("./online-world-crypto.cjs");
const { packProgram, parseProgram, injectSandboxCsp, composeSingleFileProgram } = require("./online-world-runtime.cjs");
const {
  GRID_GAME_ID,
  GRID_SIZE,
  staticCell,
  createWorld,
  settleWorld,
  applyIntent,
  buildGeneralGenerationRequest,
  projectWorldState
} = require("./grid-world-game.cjs");

const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 10000;
const POLL_INTERVAL_MS = 5000;
const DIRECT_RATE_WINDOW_MS = 60 * 1000;
const DIRECT_SEND_LIMIT = 12;
const DIRECT_RECEIVE_LIMIT_PER_SENDER = 20;
const INTENT_RATE_WINDOW_MS = 60 * 1000;
const INTENT_RATE_LIMIT = 30;
const INTENT_PROCESS_LIMIT_PER_SYNC = 60;

function builtInGridProgram() {
  const directory = path.join(__dirname, "desktop", "online-world", "grid-conquest");
  const html = composeSingleFileProgram(
    fs.readFileSync(path.join(directory, "index.html"), "utf8"),
    fs.readFileSync(path.join(directory, "styles.css"), "utf8"),
    fs.readFileSync(path.join(directory, "game.js"), "utf8")
  );
  const packed = packProgram({ gameId: GRID_GAME_ID, title: "烽火慧眼", html });
  return { manifest: { format: "fyow.program/1", gameId: GRID_GAME_ID, title: "烽火慧眼", apiVersion: 1 }, digest: packed.digest, html: injectSandboxCsp(html), compressedBytes: packed.compressedBytes, source: "builtin-preview" };
}

function workReference(value, origin) {
  const url = new URL(String(value || ""), origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("伴生作品地址必须使用 HTTP 或 HTTPS");
  const match = url.pathname.match(/^\/(?:zh\/)?explore\/installed\/([^/?#]+)\/?$/i);
  if (!match) throw new Error("请输入风月已安装作品页面地址");
  const workId = decodeURIComponent(match[1]);
  if (!/^[0-9a-z-]{8,80}$/i.test(workId)) throw new Error("作品编号格式无效");
  return { workId, url: `${origin}/zh/explore/installed/${encodeURIComponent(workId)}` };
}

function firstObject(value, predicate) {
  const queue = [{ value, depth: 0 }];
  const seen = new Set();
  while (queue.length && seen.size < 300) {
    const item = queue.shift();
    if (!item.value || typeof item.value !== "object" || seen.has(item.value) || item.depth > 7) continue;
    seen.add(item.value);
    if (!Array.isArray(item.value) && predicate(item.value)) return item.value;
    for (const child of Array.isArray(item.value) ? item.value : Object.values(item.value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: item.depth + 1 });
    }
  }
  return null;
}

function normalizeWorkDetail(payload, fallbackId) {
  const detail = firstObject(payload, item => String(item?.id || item?.app_id || "") === String(fallbackId))
    || payload?.data?.app || payload?.app || payload?.data || payload;
  return {
    id: String(detail?.id || detail?.app_id || fallbackId),
    name: String(detail?.name || detail?.title || "在线游戏世界"),
    description: String(detail?.description || detail?.desc || ""),
    authorAccountId: String(detail?.created_by_account_id || detail?.author?.id || detail?.account_id || ""),
    authorName: String(detail?.created_by_account_name || detail?.author?.name || detail?.account_name || "")
  };
}

function commentId(value) {
  return String(value?.id || value?.comment_id || value?.data?.id || value?.data?.comment_id || value?.comment?.id || value?.data?.comment?.id || "");
}

function commentAccountId(value) {
  return String(value?.account_id || value?.accountId || value?.created_by_account_id || value?.from_account_id || value?.account?.id || value?.user?.id || value?.author?.id || value?.created_by?.id || value?.sender?.id || "");
}

function parseJsonAnswer(value) {
  const text = String(value || "").trim();
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) { try { return JSON.parse(fenced); } catch {} }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  throw new Error("模型没有返回有效 JSON");
}

function exportedConfig(payload) {
  return firstObject(payload, item => Object.hasOwn(item, "world_book") && (Object.hasOwn(item, "prpt") || Object.hasOwn(item, "pre_prompt")))
    || payload?.data || payload;
}

function modelConfigSavePayload(exported, workId, name, description) {
  const payload = JSON.parse(JSON.stringify(exported || {}));
  payload.app = {
    ...(payload.app && typeof payload.app === "object" ? payload.app : {}),
    id: String(workId),
    name: String(name),
    description: String(description)
  };
  payload.pre_prompt = payload.pre_prompt ?? payload.prpt ?? "";
  payload.pre_text = payload.pre_text ?? payload.pretxt ?? "";
  payload.post_text = payload.post_text ?? payload.posttxt ?? "";
  payload.world_book = Array.isArray(payload.world_book) ? payload.world_book : [];
  return payload;
}

function coreConfigMatches(exported, expected) {
  const fields = value => ({
    description: String(value?.desc ?? value?.description ?? value?.app?.description ?? ""),
    prePrompt: String(value?.prpt ?? value?.pre_prompt ?? ""),
    preText: String(value?.pretxt ?? value?.pre_text ?? ""),
    postText: String(value?.posttxt ?? value?.post_text ?? ""),
    worldBook: value?.world_book || []
  });
  return canonicalJson(fields(exported)) === canonicalJson(fields(expected));
}

function normalizeWorldState(value) {
  if (!value || typeof value !== "object") return value;
  value.cells ||= {};
  value.players ||= {};
  value.privatePlayers ||= {};
  value.generals ||= {};
  value.jobs ||= {};
  value.processedIntents ||= [];
  return value;
}

function extractContentItems(payload) {
  const result = [];
  const queue = [{ value: payload, depth: 0 }];
  const seen = new Set();
  while (queue.length && seen.size < 1500) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8) continue;
    seen.add(value);
    if (!Array.isArray(value) && typeof value.content === "string") result.push(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return result;
}

function extractChats(payload) {
  const result = [];
  const queue = [{ value: payload, depth: 0 }];
  const seen = new Set();
  const ids = new Set();
  while (queue.length && seen.size < 1000) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 7) continue;
    seen.add(value);
    const id = String(value.id || value.chat_id || "");
    const peer = String(value?.other_account?.id || value?.receive_id || value?.receiver?.id || value?.account?.id || "");
    if (!Array.isArray(value) && id && peer && !ids.has(id)) { ids.add(id); result.push({ ...value, id, peerAccountId: peer }); }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return result;
}

class OnlineWorldService {
  constructor(options = {}) {
    this.requestConsole = options.requestConsole;
    this.requestGo = options.requestGo;
    this.requestModel = options.requestModel;
    this.getAccount = options.getAccount;
    this.getIdentity = options.getIdentity;
    this.getOrigin = options.getOrigin;
    this.onChange = options.onChange || (() => {});
    this.cacheFile = options.cacheFile;
    this.rawNow = options.now || (() => Date.now());
    this.monotonicNow = options.monotonicNow || (() => performance.now());
    this.clockAnchor = null;
    this.lastClockCalibrationAt = null;
    this.lastClockCalibrationMono = null;
    this.readPlatformTime = options.readPlatformTime;
    this.now = () => this.clockAnchor ? this.clockAnchor.platformTime + (this.monotonicNow() - this.clockAnchor.monotonicTime) : this.rawNow();
    this.work = null;
    this.program = builtInGridProgram();
    this.control = null;
    this.world = null;
    this.status = "closed";
    this.syncing = false;
    this.error = null;
    this.lastSyncAt = null;
    this.knownCommentIds = new Set();
    this.history = { pagesRead: 0, commentsRead: 0, stoppedBy: null, incomplete: 0, invalid: 0 };
    this.pendingMigration = null;
    this.directInbox = [];
    this.seenDirectMessageIds = new Set();
    this.directSendTimes = [];
    this.directReceiveTimes = new Map();
    this.intentSubmitTimes = [];
    this.authorityIntentTimes = new Map();
    this.worldBookFingerprint = null;
    this.pollTimer = null;
    this.mapFactsCache = null;
  }

  account() {
    const account = this.getAccount?.() || {};
    return { accountId: String(account.accountId || ""), username: String(account.username || "") };
  }

  isAuthority() {
    return Boolean(this.control && this.account().accountId && this.account().accountId === this.control.authorityAccountId);
  }

  summary() {
    return {
      status: this.status,
      syncing: this.syncing,
      error: this.error,
      work: this.work ? { ...this.work, description: undefined } : null,
      initialized: Boolean(this.control && this.world),
      isAuthor: Boolean(this.work?.authorAccountId && this.work.authorAccountId === this.account().accountId),
      isAuthority: this.isAuthority(),
      revision: Number(this.world?.revision || 0),
      lastSyncAt: this.lastSyncAt,
      history: { ...this.history },
      migration: this.pendingMigration ? { ...this.pendingMigration } : null,
      directInboxCount: this.directInbox.length,
      clock: { source: this.lastClockCalibrationAt ? "platform-date" : "host", calibratedAt: this.lastClockCalibrationAt, offsetMs: Math.round(this.now() - this.rawNow()) },
      program: { source: this.program.source, digest: this.program.digest, title: this.program.manifest?.title || "烽火慧眼", apiVersion: this.program.manifest?.apiVersion || 1 }
    };
  }

  state() {
    const account = this.account();
    const projection = this.world ? projectWorldState(this.world, account.accountId) : null;
    if (projection && !this.mapFactsCache) {
      this.mapFactsCache = [];
      for (let y = 0; y < GRID_SIZE; y += 1) for (let x = 0; x < GRID_SIZE; x += 1) this.mapFactsCache.push(staticCell(projection.seed, x, y));
    }
    return {
      ...this.summary(),
      account,
      control: this.control ? {
        gameId: this.control.gameId,
        seasonId: this.control.seasonId,
        programHash: this.control.programHash,
        authorityAccountId: this.control.authorityAccountId,
        startedAt: this.control.startedAt
      } : null,
      world: projection,
      mapFacts: projection ? this.mapFactsCache : [],
      directInbox: this.directInbox.slice(-100),
      programHtml: this.program?.html || null,
      serverNow: this.now()
    };
  }

  notify() {
    try { this.onChange(this.state()); } catch {}
  }

  loadCache(workId) {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return null;
    try {
      const root = readJsonWithBackupSync(fs, this.cacheFile, value => value?.version === 1 && value?.worlds && typeof value.worlds === "object").value;
      return root?.worlds?.[workId] || null;
    } catch { return null; }
  }

  saveCache() {
    if (!this.cacheFile || !this.work || !this.world) return;
    let root = { version: 1, worlds: {} };
    try {
      if (fs.existsSync(this.cacheFile)) root = readJsonWithBackupSync(fs, this.cacheFile, value => value?.version === 1 && value?.worlds && typeof value.worlds === "object").value || root;
    } catch {}
    root.worlds[this.work.id] = { control: this.control, world: this.world, directInbox: this.directInbox.slice(-100), seenDirectMessageIds: [...this.seenDirectMessageIds].slice(-500), updatedAt: this.now() };
    atomicWriteJsonSync(fs, this.cacheFile, root, { pretty: false });
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.sync(false).catch(() => {}), POLL_INTERVAL_MS);
  }

  close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.saveCache();
    this.status = "closed";
    this.notify();
  }

  currentProgramHash() {
    return this.program.digest;
  }

  async calibrateClock() {
    if (typeof this.readPlatformTime !== "function") return null;
    const before = this.rawNow();
    const platformTime = Number(await this.readPlatformTime());
    const after = this.rawNow();
    if (!Number.isFinite(platformTime) || Math.abs(platformTime - after) > 24 * 60 * 60 * 1000) throw new Error("平台时间校准值无效");
    this.clockAnchor = { platformTime: platformTime + (after - before) / 2, monotonicTime: this.monotonicNow() };
    this.lastClockCalibrationAt = after;
    this.lastClockCalibrationMono = this.monotonicNow();
    return this.now();
  }

  async open({ workUrl, orientation, displayName } = {}) {
    const account = this.account();
    if (!account.accountId) throw new Error("请先登录风月账号");
    const origin = String(this.getOrigin?.() || "").replace(/\/$/, "");
    const reference = workReference(workUrl, origin);
    this.status = "opening";
    this.error = null;
    this.notify();
    await this.calibrateClock().catch(() => null);
    const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(reference.workId)}`);
    this.work = { ...normalizeWorkDetail(payload, reference.workId), url: reference.url };
    this.program = parseProgram(this.work.description, GRID_GAME_ID) || builtInGridProgram();
    this.mapFactsCache = null;
    const cached = this.loadCache(this.work.id);
    if (cached?.world?.gameId === GRID_GAME_ID) {
      this.control = cached.control || null;
      this.world = normalizeWorldState(cached.world);
      this.directInbox = Array.isArray(cached.directInbox) ? cached.directInbox.slice(-100) : [];
      this.seenDirectMessageIds = new Set(Array.isArray(cached.seenDirectMessageIds) ? cached.seenDirectMessageIds : this.directInbox.map(item => item.messageId));
    } else {
      this.control = null;
      this.world = null;
    }
    this.pendingJoin = {
      orientation: ["men", "women", "any"].includes(orientation) ? orientation : "any",
      displayName: String(displayName || account.username || "玩家").slice(0, 40)
    };
    await this.sync(true);
    this.status = this.control && this.world ? "ready" : "needs-initialization";
    this.startPolling();
    this.notify();
    return this.state();
  }

  async refreshWorkProgram() {
    if (!this.work) return null;
    const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(this.work.id)}`);
    this.work = { ...normalizeWorkDetail(payload, this.work.id), url: this.work.url };
    this.program = parseProgram(this.work.description, GRID_GAME_ID) || builtInGridProgram();
    return this.program;
  }

  async initialize() {
    if (!this.work) throw new Error("请先选择伴生作品");
    if (this.program?.source !== "work-description") throw new Error("伴生作品详细介绍尚未包含有效游戏程序包");
    const account = this.account();
    if (!this.work.authorAccountId || account.accountId !== this.work.authorAccountId) throw new Error("只有作品作者可以初始化新赛季");
    const identity = await this.getIdentity();
    const world = createWorld({ authorityAccountId: account.accountId, startedAt: this.now() });
    const programHash = this.currentProgramHash();
    this.control = signRecord({
      schema: FYOW_SCHEMAS.control,
      id: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: world.seasonId,
      rulesVersion: 1,
      programHash,
      authorityAccountId: account.accountId,
      authoritySigningPublicKey: identity.signingPublicKey,
      authorityEncryptionPublicKey: identity.encryptionPublicKey,
      authorityPolicy: "single-authority-with-client-audit",
      startedAt: world.startedAt,
      updatedAt: world.startedAt
    }, identity.signingPrivateKey);
    this.world = world;
    await this.postRecord(this.control);
    await this.publishSnapshot();
    this.status = "ready";
    this.saveCache();
    this.notify();
    return this.state();
  }

  async activateProgramUpdate() {
    if (!this.work || !this.control || this.account().accountId !== this.work.authorAccountId) throw new Error("只有作品作者可以启用游戏程序更新");
    const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(this.work.id)}`);
    this.work = { ...normalizeWorkDetail(payload, this.work.id), url: this.work.url };
    const program = parseProgram(this.work.description, GRID_GAME_ID);
    if (!program) throw new Error("伴生作品详细介绍尚未包含有效游戏程序包");
    this.program = program;
    const identity = await this.getIdentity();
    const unsigned = {
      ...this.control,
      id: crypto.randomUUID(),
      programHash: this.currentProgramHash(),
      authoritySigningPublicKey: identity.signingPublicKey,
      authorityEncryptionPublicKey: identity.encryptionPublicKey,
      updatedAt: this.now()
    };
    delete unsigned.signature;
    this.control = signRecord(unsigned, identity.signingPrivateKey);
    await this.postRecord(this.control);
    await this.publishSnapshot();
    this.error = null;
    this.status = "ready";
    this.saveCache();
    this.notify();
    return this.state();
  }

  async postComment(content, options = {}) {
    if (String(content).length > 1000) throw new Error("评论数据超过 1000 字符限制");
    const body = { is_anonymous: false, biz_type: 1, content: String(content) };
    if (options.parentId) {
      body.parent_id = String(options.parentId);
      body.to_account_id = String(options.toAccountId || "");
      if (options.toCommentId) body.to_comment_id = String(options.toCommentId);
    }
    return this.requestConsole(`/comments/${encodeURIComponent(this.work.id)}/1`, { method: "POST", body, timeout: 20000 });
  }

  async postRecord(record, options = {}) {
    const responses = [];
    for (const content of encodeCommentRecord(record)) responses.push(await this.postComment(content, options));
    return responses;
  }

  async readHistory(fullScan) {
    const all = [];
    const seen = new Set();
    let stoppedBy = null;
    let pagesRead = 0;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const payload = await this.requestConsole(`/comments/${encodeURIComponent(this.work.id)}/1?page=${page}&limit=${HISTORY_PAGE_SIZE}&order=desc&filter_type=all`, { timeout: 20000 });
      const comments = extractCommentItems(payload);
      pagesRead = page;
      for (const comment of comments) {
        const id = commentId(comment);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(comment);
      }
      const assembled = assembleCommentRecords(all);
      const decision = historyPageDecision({ pageComments: comments, assembled, knownCommentIds: [...this.knownCommentIds], fullScan, requireControl: !this.control });
      if (decision.stop || comments.length < HISTORY_PAGE_SIZE) {
        stoppedBy = decision.stop ? decision.reason : "last-partial-page";
        break;
      }
    }
    const assembled = assembleCommentRecords(all);
    this.history = { pagesRead, commentsRead: all.length, stoppedBy: stoppedBy || "page-limit", incomplete: assembled.incomplete.length, invalid: assembled.invalid.length };
    for (const comment of all.slice(0, HISTORY_PAGE_SIZE * 2)) this.knownCommentIds.add(commentId(comment));
    if (this.knownCommentIds.size > 500) this.knownCommentIds = new Set([...this.knownCommentIds].slice(-500));
    return { comments: all, assembled };
  }

  validAuthorSource(item) {
    return (item.sources || []).some(source => commentIsFromAuthor(source) || commentAccountId(source) === this.work.authorAccountId);
  }

  async sync(fullScan = false) {
    if (!this.work || this.syncing) return this.state();
    this.syncing = true;
    this.error = null;
    this.notify();
    try {
      if (this.lastClockCalibrationMono == null || this.monotonicNow() - this.lastClockCalibrationMono > 60 * 60 * 1000) await this.calibrateClock().catch(() => null);
      const history = await this.readHistory(Boolean(fullScan || !this.control));
      const controls = history.assembled.records
        .filter(item => item.record?.schema === FYOW_SCHEMAS.control && item.record.workId === this.work.id && item.record.gameId === GRID_GAME_ID && this.validAuthorSource(item))
        .filter(item => verifySignedRecord(item.record, item.record.authoritySigningPublicKey))
        .sort((left, right) => Number(right.record.updatedAt || right.record.startedAt || 0) - Number(left.record.updatedAt || left.record.startedAt || 0));
      if (controls[0]) this.control = controls[0].record;
      if (this.control) {
        if (this.control.programHash !== this.currentProgramHash()) await this.refreshWorkProgram();
        if (this.control.programHash !== this.currentProgramHash()) throw new Error("作品详细介绍中的游戏程序尚未由作者签名启用");
        const snapshots = history.assembled.records
          .filter(item => item.record?.schema === FYOW_SCHEMAS.snapshot && item.record.seasonId === this.control.seasonId && item.record.workId === this.work.id && item.record.gameId === GRID_GAME_ID)
          .filter(item => verifySignedRecord(item.record, this.control.authoritySigningPublicKey))
          .filter(item => item.record.stateHash === sha256(Buffer.from(canonicalJson(item.record.state))))
          .sort((left, right) => Number(right.record.revision || 0) - Number(left.record.revision || 0));
        const snapshot = snapshots[0]?.record;
        const cachedStateIsCurrent = this.world && Number(this.world.revision || 0) >= Number(snapshot?.revision || 0);
        if (snapshot && !cachedStateIsCurrent) this.world = normalizeWorldState(snapshot.state);
        normalizeWorldState(this.world);
        if (snapshot && this.isAuthority()) await this.restoreAuthoritySnapshot(snapshot);
        await this.restoreVaults(history.assembled.records);
        if (this.isAuthority() && this.world) await this.processPendingIntents(history.assembled.records);
        if (this.isAuthority() && this.world) await this.settleAuthorityClock();
        await this.reconcileOwnGeneralWorldBooks();
        await this.receiveDirectWakes().catch(() => []);
        const resets = history.assembled.records
          .filter(item => item.record?.schema === FYOW_SCHEMAS.reset && item.record.seasonId === this.control.seasonId && this.validAuthorSource(item))
          .filter(item => verifySignedRecord(item.record, this.control.authoritySigningPublicKey))
          .sort((left, right) => Number(right.record.issuedAt || 0) - Number(left.record.issuedAt || 0));
        if (resets[0]) this.pendingMigration = { workId: resets[0].record.newWorkId, url: resets[0].record.newWorkUrl, issuedAt: resets[0].record.issuedAt };
      }
      this.status = this.control && this.world ? "ready" : "needs-initialization";
      this.lastSyncAt = this.now();
      this.saveCache();
      this.notify();
      return this.state();
    } catch (error) {
      this.error = error?.message || String(error);
      this.status = this.world ? "degraded" : "error";
      this.notify();
      throw error;
    } finally {
      this.syncing = false;
      this.notify();
    }
  }

  async restoreVaults(records) {
    if (!this.control || !this.world) return;
    const currentAccountId = this.account().accountId;
    const allowedAccounts = this.isAuthority() ? null : new Set([currentAccountId]);
    const vaults = records
      .filter(item => item.record?.schema === FYOW_SCHEMAS.privateVault && item.record.seasonId === this.control.seasonId)
      .filter(item => !allowedAccounts || allowedAccounts.has(String(item.record.accountId)))
      .filter(item => verifySignedRecord(item.record, this.control.authoritySigningPublicKey))
      .sort((left, right) => Number(right.record.revision || 0) - Number(left.record.revision || 0));
    if (!vaults.length) return;
    const latestByAccount = new Map();
    for (const item of vaults) if (!latestByAccount.has(String(item.record.accountId))) latestByAccount.set(String(item.record.accountId), item.record);
    const identity = await this.getIdentity();
    normalizeWorldState(this.world);
    for (const [accountId, vault] of latestByAccount) {
      try {
        const context = `${this.work.id}/${this.control.seasonId}/${accountId}`;
        const box = accountId === currentAccountId ? (vault.playerBox || vault.box) : vault.authorityBox;
        if (!box) continue;
        const privateState = openSealedJson(box, identity.encryptionPrivateKey, context);
        if (vault.commitment !== sha256(Buffer.from(canonicalJson(privateState)))) continue;
        if (privateState.privatePlayer) this.world.privatePlayers[accountId] = privateState.privatePlayer;
        if (this.world.players[accountId] && privateState.player) Object.assign(this.world.players[accountId], privateState.player);
        for (const general of privateState.generals || []) this.world.generals[general.id] = general;
        for (const job of privateState.jobs || []) this.world.jobs[job.id] = job;
      } catch {}
    }
  }

  async restoreAuthoritySnapshot(snapshot) {
    if (!snapshot?.authorityBox || !this.isAuthority() || !this.world) return;
    try {
      const identity = await this.getIdentity();
      const context = `${this.work.id}/${this.control.seasonId}/snapshot/${snapshot.snapshotId}`;
      const privateState = openSealedJson(snapshot.authorityBox, identity.encryptionPrivateKey, context);
      normalizeWorldState(this.world);
      Object.assign(this.world.privatePlayers, privateState.privatePlayers || {});
      for (const [accountId, fields] of Object.entries(privateState.players || {})) if (this.world.players[accountId]) Object.assign(this.world.players[accountId], fields);
      for (const general of privateState.generals || []) this.world.generals[general.id] = general;
      for (const job of privateState.jobs || []) this.world.jobs[job.id] = job;
    } catch {}
  }

  async processPendingIntents(records) {
    const pending = records
      .filter(item => item.record?.schema === FYOW_SCHEMAS.intent
        && item.record.seasonId === this.control.seasonId
        && item.record.workId === this.work.id
        && item.record.gameId === GRID_GAME_ID)
      .sort((left, right) => Number(left.record.createdAt || 0) - Number(right.record.createdAt || 0));
    let processedThisSync = 0;
    for (const item of pending) {
      if (processedThisSync >= INTENT_PROCESS_LIMIT_PER_SYNC) break;
      const record = item.record;
      if (this.world.processedIntents?.includes(record.idempotencyKey)) continue;
      const sourceMatches = item.sources.some(source => commentAccountId(source) === record.actorAccountId);
      if (!sourceMatches || !verifySignedRecord(record, record.deviceSigningPublicKey)) continue;
      if (!this.consumeAuthorityIntentBudget(record.actorAccountId)) continue;
      processedThisSync += 1;
      const boundPlayer = this.world.players?.[record.actorAccountId];
      if (boundPlayer?.deviceSigningPublicKey && boundPlayer.deviceSigningPublicKey !== record.deviceSigningPublicKey) {
        await this.rejectIntent(record, new Error("玩家设备签名密钥与本赛季绑定不一致"));
        continue;
      }
      try {
        let intent = { ...record.intent, idempotencyKey: record.idempotencyKey };
        if (intent.type === "join") {
          const identity = await this.getIdentity();
          const context = `${this.work.id}/${this.control.seasonId}/${record.actorAccountId}/join`;
          const privateJoin = openSealedJson(record.privateBox, identity.encryptionPrivateKey, context);
          intent = { ...intent, orientation: privateJoin.orientation };
        }
        await this.applyAuthorityIntent(intent, record.actorAccountId, {
          deviceSigningPublicKey: record.deviceSigningPublicKey,
          deviceEncryptionPublicKey: record.deviceEncryptionPublicKey,
          sourceCommentId: commentId(item.sources[0])
        });
      } catch (error) {
        if (!this.world.processedIntents?.includes(record.idempotencyKey)) await this.rejectIntent(record, error);
      }
    }
  }

  async rejectIntent(record, error) {
    this.world.processedIntents ||= [];
    this.world.processedIntents.push(String(record.idempotencyKey));
    if (this.world.processedIntents.length > 1000) this.world.processedIntents.splice(0, this.world.processedIntents.length - 1000);
    this.world.revision = Number(this.world.revision || 0) + 1;
    const identity = await this.getIdentity();
    const event = signRecord({
      schema: FYOW_SCHEMAS.event,
      eventId: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      revision: this.world.revision,
      actorAccountId: record.actorAccountId,
      type: "intent-rejected",
      intent: { type: String(record.intent?.type || "unknown"), idempotencyKey: record.idempotencyKey },
      result: { accepted: false, reason: String(error?.message || error || "行动无效").slice(0, 200) },
      createdAt: this.now()
    }, identity.signingPrivateKey);
    await this.postRecord(event);
    await this.publishSnapshot();
  }

  async submitIntent(intent = {}) {
    if (!this.control || !this.world) throw new Error("本赛季尚未初始化");
    this.consumeIntentSubmitBudget();
    const account = this.account();
    const normalized = { ...intent, idempotencyKey: String(intent.idempotencyKey || crypto.randomUUID()) };
    if (this.isAuthority()) return this.applyAuthorityIntent(normalized, account.accountId, { self: true });
    const identity = await this.getIdentity();
    let publicIntent = { ...normalized };
    let privateBox = null;
    if (publicIntent.type === "join") {
      const orientation = ["men", "women", "any"].includes(publicIntent.orientation) ? publicIntent.orientation : this.pendingJoin?.orientation;
      delete publicIntent.orientation;
      const context = `${this.work.id}/${this.control.seasonId}/${account.accountId}/join`;
      privateBox = sealJson({ orientation }, this.control.authorityEncryptionPublicKey, context);
    }
    const record = signRecord({
      schema: FYOW_SCHEMAS.intent,
      intentId: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      actorAccountId: account.accountId,
      idempotencyKey: normalized.idempotencyKey,
      intent: publicIntent,
      privateBox,
      ...publicIdentity(identity),
      deviceSigningPublicKey: identity.signingPublicKey,
      deviceEncryptionPublicKey: identity.encryptionPublicKey,
      createdAt: this.now()
    }, identity.signingPrivateKey);
    await this.postRecord(record);
    return { queued: true, intentId: record.intentId, idempotencyKey: record.idempotencyKey };
  }

  consumeIntentSubmitBudget() {
    const now = this.now();
    this.intentSubmitTimes = this.intentSubmitTimes.filter(timestamp => now - timestamp < INTENT_RATE_WINDOW_MS);
    if (this.intentSubmitTimes.length >= INTENT_RATE_LIMIT) throw new Error("游戏行动提交过于频繁，请稍后再试");
    this.intentSubmitTimes.push(now);
  }

  consumeAuthorityIntentBudget(accountId) {
    const now = this.now();
    const key = String(accountId);
    const times = (this.authorityIntentTimes.get(key) || []).filter(timestamp => now - timestamp < INTENT_RATE_WINDOW_MS);
    if (times.length >= INTENT_RATE_LIMIT) {
      this.authorityIntentTimes.set(key, times);
      return false;
    }
    times.push(now);
    this.authorityIntentTimes.set(key, times);
    return true;
  }

  sanitizedEvent(event) {
    if (event.type === "talk-general") return { ...event, result: { generalId: event.result.generalId, modelRequested: true } };
    if (event.type === "grant-general") return { ...event, result: { generalGranted: true } };
    return event;
  }

  async applyAuthorityIntent(intent, actorAccountId, metadata = {}) {
    if (!this.isAuthority()) throw new Error("当前账号不是本局权威端");
    const identity = await this.getIdentity();
    const outcome = applyIntent(this.world, intent, { actorAccountId, authorityAccountId: this.control.authorityAccountId, now: this.now() });
    if (outcome.duplicate) return { duplicate: true, state: this.state() };
    this.world = outcome.state;
    if (intent.type === "join") {
      const player = this.world.players[actorAccountId];
      player.deviceSigningPublicKey = metadata.deviceSigningPublicKey || identity.signingPublicKey;
      player.deviceEncryptionPublicKey = metadata.deviceEncryptionPublicKey || identity.encryptionPublicKey;
      player.commentRootId = metadata.sourceCommentId || await this.postPlayerPresence(player);
    }
    const signedEvent = signRecord(this.sanitizedEvent(outcome.event), identity.signingPrivateKey);
    await this.postRecord(signedEvent);
    await this.handleWorldBookTransition(intent, outcome, actorAccountId);
    await this.publishSnapshot();
    const affectedAccounts = new Set([actorAccountId, ...(outcome.effects || []).map(effect => effect.accountId).filter(Boolean)]);
    for (const accountId of affectedAccounts) await this.publishPrivateVault(accountId);
    let dialogue = null;
    if (outcome.result?.modelRequest) dialogue = await this.completeDialogue(outcome.result.modelRequest, actorAccountId, intent);
    await this.handleEffects(outcome.effects, identity);
    this.saveCache();
    this.notify();
    return { event: signedEvent, effects: outcome.effects, dialogue, state: this.state() };
  }

  async settleAuthorityClock() {
    if (!this.isAuthority() || !this.world) return [];
    const settled = settleWorld(this.world, this.now());
    if (!settled.effects.length) return [];
    this.world = normalizeWorldState(settled.state);
    this.world.revision = Number(this.world.revision || 0) + 1;
    const identity = await this.getIdentity();
    const event = signRecord({
      schema: FYOW_SCHEMAS.event,
      eventId: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      revision: this.world.revision,
      actorAccountId: this.control.authorityAccountId,
      type: "time-settle",
      result: { effects: settled.effects },
      createdAt: settled.now
    }, identity.signingPrivateKey);
    await this.postRecord(event);
    await this.publishSnapshot();
    for (const accountId of new Set(settled.effects.map(effect => effect.accountId).filter(Boolean))) await this.publishPrivateVault(accountId);
    await this.handleEffects(settled.effects, identity);
    this.saveCache();
    return settled.effects;
  }

  async postPlayerPresence(player) {
    const response = await this.postComment(`§FYOW3§PLAYER§${player.accountId}§${String(player.displayName || "玩家").slice(0, 40)}§${this.control.seasonId}`);
    return commentId(response) || null;
  }

  async publishSnapshot() {
    const identity = await this.getIdentity();
    const state = projectWorldState(this.world, null);
    const snapshotId = crypto.randomUUID();
    const authorityPrivateState = {
      privatePlayers: this.world.privatePlayers || {},
      players: Object.fromEntries(Object.entries(this.world.players || {}).map(([accountId, player]) => [accountId, { gold: Number(player.gold || 0), fieldArmySoldiers: Number(player.fieldArmySoldiers || 0), carriedGeneralIds: [...(player.carriedGeneralIds || [])] }])),
      generals: Object.values(this.world.generals || {}).filter(general => general.status !== "deployed"),
      jobs: Object.values(this.world.jobs || {})
    };
    const context = `${this.work.id}/${this.control.seasonId}/snapshot/${snapshotId}`;
    const snapshot = signRecord({
      schema: FYOW_SCHEMAS.snapshot,
      snapshotId,
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      revision: Number(this.world.revision || 0),
      state,
      stateHash: sha256(Buffer.from(canonicalJson(state))),
      authorityBox: sealJson(authorityPrivateState, this.control.authorityEncryptionPublicKey, context),
      createdAt: this.now()
    }, identity.signingPrivateKey);
    await this.postRecord(snapshot);
    return snapshot;
  }

  async publishPrivateVault(accountId) {
    const player = this.world.players[accountId];
    if (!player?.deviceEncryptionPublicKey) return null;
    const identity = await this.getIdentity();
    const context = `${this.work.id}/${this.control.seasonId}/${accountId}`;
    const privateState = {
      privatePlayer: this.world.privatePlayers?.[accountId] || null,
      player: {
        gold: Number(player.gold || 0),
        fieldArmySoldiers: Number(player.fieldArmySoldiers || 0),
        carriedGeneralIds: [...(player.carriedGeneralIds || [])]
      },
      generals: Object.values(this.world.generals || {}).filter(general => general.holderAccountId === accountId && general.status !== "deployed"),
      jobs: Object.values(this.world.jobs || {}).filter(job => job.accountId === accountId)
    };
    const vault = signRecord({
      schema: FYOW_SCHEMAS.privateVault,
      id: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      accountId,
      revision: Number(this.world.revision || 0),
      commitment: sha256(Buffer.from(canonicalJson(privateState))),
      playerBox: sealJson(privateState, player.deviceEncryptionPublicKey, context),
      authorityBox: sealJson(privateState, this.control.authorityEncryptionPublicKey, context),
      createdAt: this.now()
    }, identity.signingPrivateKey);
    await this.postRecord(vault);
    return vault;
  }

  async handleEffects(effects, identity) {
    for (const effect of effects || []) {
      if (effect.type !== "general-generation-request") continue;
      const request = buildGeneralGenerationRequest(this.world, effect, crypto.randomUUID());
      const answer = await this.requestModel(request);
      const parsed = parseJsonAnswer(answer?.answer ?? answer);
      const setting = String(parsed.setting || "").trim().slice(0, 1000);
      if (!setting) throw new Error("将领生成结果缺少设定");
      await this.applyAuthorityIntent({
        type: "grant-general",
        generalId: crypto.randomUUID(),
        discoveryId: request.idempotencyKey,
        name: String(parsed.name || "无名将领").slice(0, 24),
        gender: effect.gender,
        location: { x: effect.x, y: effect.y },
        setting,
        power: Math.max(100, Math.min(5000, Number(parsed.power) || 300)),
        idempotencyKey: `general:${request.idempotencyKey}`
      }, effect.accountId, { internal: true });
    }
  }

  async completeDialogue(request, actorAccountId, intent) {
    const general = this.world.generals?.[intent.generalId];
    const answer = await this.requestModelWithGeneralWorldBook(request, general);
    const parsed = parseJsonAnswer(answer?.answer ?? answer);
    const reply = String(parsed.reply || "").trim().slice(0, 2000);
    await this.applyAuthorityIntent({ type: "record-general-dialogue", generalId: intent.generalId, topic: parsed.memoryTopic || intent.topic, intimacyDelta: Number(parsed.intimacyDelta || 1), idempotencyKey: `dialogue:${intent.idempotencyKey}` }, actorAccountId, { internal: true });
    return { reply, intimacyDelta: Number(parsed.intimacyDelta || 1) };
  }

  async requestModelWithGeneralWorldBook(request, general) {
    if (!general) return this.requestModel(request);
    const payload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(this.work.id)}`, { timeout: 15000 });
    const config = payload?.data?.data ?? payload?.data ?? payload ?? {};
    const original = Array.isArray(config.world_book) ? config.world_book : [];
    const marker = `FYOW_GENERAL:${general.id}`;
    if (original.some(entry => String(entry?.value || "").includes(marker))) return this.requestModel(request);
    await this.requestGo("/apps/config", { method: "POST", body: { app_id: this.work.id, world_book: [...original, this.generalWorldBookEntry(general)] }, timeout: 15000 });
    try {
      return await this.requestModel(request);
    } finally {
      await this.requestGo("/apps/config", { method: "POST", body: { app_id: this.work.id, world_book: original }, timeout: 15000 }).catch(() => {});
    }
  }

  async handleWorldBookTransition(intent, outcome, actorAccountId) {
    const generalId = String(intent.generalId || outcome.result?.generalId || "");
    const general = this.world.generals?.[generalId];
    if (!general) return;
    if (intent.type === "deploy-general") {
      if (String(actorAccountId) === this.account().accountId) {
        this.worldBookFingerprint = null;
        await this.reconcileOwnGeneralWorldBooks();
      }
      await this.postGeneralArchive(general, outcome.result.x, outcome.result.y);
    } else if ((intent.type === "recall-general" || intent.type === "grant-general") && String(actorAccountId) === this.account().accountId) {
      this.worldBookFingerprint = null;
      await this.reconcileOwnGeneralWorldBooks();
    }
  }

  generalWorldBookEntry(general) {
    const marker = `FYOW_GENERAL:${general.id}`;
    return {
      group: "在线游戏世界/随行将领",
      match_type: 2,
      key: `_or_${general.name}`,
      key_region: 2,
      value_type: 0,
      value: `${marker}\n将领设定：${general.setting}\n将领记忆：${general.memoryText || "暂无"}`.slice(0, 6000),
      value_configs: [], value_region: 1, sort: 0, depth: 0, probability: 100, enable: true
    };
  }

  async reconcileOwnGeneralWorldBooks() {
    if (!this.world || !this.work) return;
    const accountId = this.account().accountId;
    const player = this.world.players?.[accountId];
    if (!player) return;
    const desired = (player.carriedGeneralIds || []).map(id => this.world.generals?.[id]).filter(Boolean);
    const fingerprint = sha256(Buffer.from(canonicalJson(desired.map(general => ({ id: general.id, name: general.name, setting: general.setting, memoryText: general.memoryText })))))
    if (fingerprint === this.worldBookFingerprint) return;
    const payload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(this.work.id)}`, { timeout: 15000 });
    const config = payload?.data?.data ?? payload?.data ?? payload ?? {};
    const worldBook = (Array.isArray(config.world_book) ? config.world_book : []).filter(entry => !String(entry?.value || "").includes("FYOW_GENERAL:"));
    worldBook.push(...desired.map(general => this.generalWorldBookEntry(general)));
    await this.requestGo("/apps/config", { method: "POST", body: { app_id: this.work.id, world_book: worldBook }, timeout: 15000 });
    const verifiedPayload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(this.work.id)}`, { timeout: 15000 });
    const verified = verifiedPayload?.data?.data ?? verifiedPayload?.data ?? verifiedPayload ?? {};
    const persisted = new Set((Array.isArray(verified.world_book) ? verified.world_book : []).map(entry => String(entry?.value || "").match(/FYOW_GENERAL:([^\s]+)/)?.[1]).filter(Boolean));
    if (persisted.size !== desired.length || desired.some(general => !persisted.has(String(general.id)))) throw new Error("将领世界书保存后校验失败");
    this.worldBookFingerprint = fingerprint;
  }

  async postGeneralArchive(general, x, y) {
    const root = await this.postComment(`§FYOW3§GENERAL§${general.id}§${general.name}§${x},${y}§r${this.world.revision}`);
    const parentId = commentId(root);
    if (!parentId) throw new Error("平台没有返回将领主评论编号");
    const target = this.control.authorityAccountId;
    const identity = await this.getIdentity();
    await this.postRecord(signRecord({ schema: FYOW_SCHEMAS.generalDefinition, id: crypto.randomUUID(), generalId: general.id, name: general.name, location: { x, y }, setting: general.setting, power: general.power, revision: this.world.revision }, identity.signingPrivateKey), { parentId, toAccountId: target });
    await this.postRecord(signRecord({ schema: FYOW_SCHEMAS.generalMemory, id: crypto.randomUUID(), generalId: general.id, name: general.name, location: { x, y }, memory: general.memoryText || "暂无", revision: this.world.revision }, identity.signingPrivateKey), { parentId, toAccountId: target });
  }

  async findPrivateChat(accountId) {
    const list = await this.requestConsole("/chats?page=1&limit=500");
    return extractChats(list).find(item => item.peerAccountId === String(accountId)) || null;
  }

  async ensurePrivateChat(accountId) {
    let chat = await this.findPrivateChat(accountId);
    if (!chat) {
      const created = await this.requestConsole("/chats", { method: "POST", body: { receive_id: accountId } });
      chat = extractChats(created).find(item => item.peerAccountId === String(accountId)) || await this.findPrivateChat(accountId);
    }
    if (!chat?.id) throw new Error("平台没有返回私信会话编号");
    return chat;
  }

  consumeDirectSendBudget() {
    const now = this.now();
    this.directSendTimes = this.directSendTimes.filter(timestamp => now - timestamp < DIRECT_RATE_WINDOW_MS);
    if (this.directSendTimes.length >= DIRECT_SEND_LIMIT) throw new Error("定向消息发送过于频繁，请稍后再试");
    this.directSendTimes.push(now);
  }

  consumeDirectReceiveBudget(accountId) {
    const now = this.now();
    const key = String(accountId);
    const times = (this.directReceiveTimes.get(key) || []).filter(timestamp => now - timestamp < DIRECT_RATE_WINDOW_MS);
    if (times.length >= DIRECT_RECEIVE_LIMIT_PER_SENDER) {
      this.directReceiveTimes.set(key, times);
      return false;
    }
    times.push(now);
    this.directReceiveTimes.set(key, times);
    return true;
  }

  async sendDirect(toAccountId, type, payload) {
    if (!this.control || !this.world) throw new Error("本赛季尚未初始化");
    const sender = this.account();
    const recipient = String(toAccountId || "");
    if (!recipient || recipient === sender.accountId) throw new Error("请选择另一名在线世界玩家");
    const messageType = String(type || "");
    if (!["diplomacy", "captured-general-letter"].includes(messageType)) throw new Error("不支持的一对一消息类型");
    const text = String(payload?.text || "").trim().slice(0, 500);
    if (!text) throw new Error("消息正文不能为空");
    let normalizedPayload = { text };
    if (messageType === "captured-general-letter") {
      const general = this.world.generals?.[String(payload?.generalId || "")];
      const player = this.world.players?.[sender.accountId];
      if (!general || general.holderAccountId !== sender.accountId || !player?.carriedGeneralIds?.includes(general.id)) throw new Error("只有当前带在身边的被俘将领可以写信");
      if (general.capturedFromAccountId !== recipient && general.loyalToAccountId !== recipient) throw new Error("这封将领书信只能发给其原效忠玩家");
      normalizedPayload = { generalId: general.id, generalName: general.name, text };
    }
    const target = this.world.players[String(toAccountId)];
    if (!target?.deviceEncryptionPublicKey || !target?.commentRootId) throw new Error("接收方尚未登记通讯密钥或评论入口");
    this.consumeDirectSendBudget();
    const identity = await this.getIdentity();
    const messageId = crypto.randomUUID();
    const context = `${this.work.id}/${this.control.seasonId}/${messageId}`;
    const direct = signRecord({ schema: FYOW_SCHEMAS.direct, messageId, gameId: GRID_GAME_ID, workId: this.work.id, seasonId: this.control.seasonId, fromAccountId: sender.accountId, toAccountId: recipient, type: messageType, box: sealJson(normalizedPayload, target.deviceEncryptionPublicKey, context), createdAt: this.now() }, identity.signingPrivateKey);
    const wake = signRecord({ schema: FYOW_SCHEMAS.directWake, messageId, gameId: GRID_GAME_ID, workId: this.work.id, seasonId: this.control.seasonId, fromAccountId: sender.accountId, toAccountId: recipient, createdAt: this.now() }, identity.signingPrivateKey);
    await this.postRecord(wake, { parentId: target.commentRootId, toAccountId: String(toAccountId) });
    const chat = await this.ensurePrivateChat(toAccountId);
    const chunks = encodeCommentRecord(direct);
    for (const content of chunks) await this.requestConsole("/chats/messages", { method: "POST", body: { chat_id: chat.id, content }, timeout: 20000 });
    return { messageId, announced: true, sent: true, chunks: chunks.length };
  }

  async receiveDirectWakes() {
    if (!this.control || !this.world) return [];
    const accountId = this.account().accountId;
    const rootId = this.world.players?.[accountId]?.commentRootId;
    if (!rootId) return [];
    const branches = await this.requestConsole(`/comments/branches/${encodeURIComponent(rootId)}`, { timeout: 15000 });
    const assembledWakes = assembleCommentRecords(extractContentItems(branches));
    const wakes = assembledWakes.records
      .map(item => item.record)
      .filter(record => record?.schema === FYOW_SCHEMAS.directWake && record.workId === this.work.id && record.seasonId === this.control.seasonId && record.toAccountId === accountId)
      .filter(record => {
        const senderKey = this.world.players?.[record.fromAccountId]?.deviceSigningPublicKey;
        return senderKey && verifySignedRecord(record, senderKey);
      })
      .filter(record => !this.seenDirectMessageIds.has(record.messageId));
    const received = [];
    const identity = wakes.length ? await this.getIdentity() : null;
    for (const wake of wakes) {
      if (!this.consumeDirectReceiveBudget(wake.fromAccountId)) {
        this.seenDirectMessageIds.add(wake.messageId);
        continue;
      }
      const chat = await this.findPrivateChat(wake.fromAccountId);
      if (!chat) continue;
      const messages = await this.requestConsole(`/chats/messages?chat_id=${encodeURIComponent(chat.id)}&page=1&limit=500`, { timeout: 15000 });
      const directs = assembleCommentRecords(extractContentItems(messages)).records
        .map(item => item.record)
        .filter(record => record?.schema === FYOW_SCHEMAS.direct && record.messageId === wake.messageId && record.fromAccountId === wake.fromAccountId && record.toAccountId === accountId)
        .filter(record => verifySignedRecord(record, this.world.players[wake.fromAccountId].deviceSigningPublicKey));
      const direct = directs[0];
      if (!direct) continue;
      try {
        const context = `${this.work.id}/${this.control.seasonId}/${direct.messageId}`;
        const payload = openSealedJson(direct.box, identity.encryptionPrivateKey, context);
        const item = { messageId: direct.messageId, fromAccountId: direct.fromAccountId, type: direct.type, payload, createdAt: direct.createdAt, receivedAt: this.now() };
        this.directInbox.push(item);
        if (this.directInbox.length > 100) this.directInbox.splice(0, this.directInbox.length - 100);
        this.seenDirectMessageIds.add(direct.messageId);
        received.push(item);
      } catch {}
    }
    return received;
  }

  async exportMigrationDraft() {
    if (!this.isAuthority() || this.account().accountId !== this.work.authorAccountId) throw new Error("只有作品作者可以迁移游戏卡");
    const exportedPayload = await this.requestConsole(`/apps/${encodeURIComponent(this.work.id)}/model-config/export`, { timeout: 30000 });
    const exported = exportedConfig(exportedPayload);
    const exportJson = canonicalJson(exported);
    const exportHash = sha256(Buffer.from(exportJson));
    const description = String(exported.desc || exported.description || this.work.description || "");
    const created = await this.requestConsole("/apps", { method: "POST", body: { name: this.work.name, description, icon: "", icon_background: "", mode: "chat", type: 2 }, timeout: 30000 });
    const newWorkId = String(created?.data?.app?.id || created?.app?.id || created?.data?.id || created?.id || "");
    if (!newWorkId) throw new Error("平台没有返回新作品编号");
    const newWorkUrl = `${this.getOrigin().replace(/\/$/, "")}/zh/explore/installed/${encodeURIComponent(newWorkId)}`;
    let configurationImported = false;
    let oldWorkRenamed = false;
    let importError = null;
    try {
      const newPayload = modelConfigSavePayload(exported, newWorkId, this.work.name, description);
      await this.requestConsole(`/apps/${encodeURIComponent(newWorkId)}/model-config`, { method: "POST", body: newPayload, timeout: 30000 });
      const verifiedPayload = await this.requestConsole(`/apps/${encodeURIComponent(newWorkId)}/model-config/export`, { timeout: 30000 });
      configurationImported = coreConfigMatches(exportedConfig(verifiedPayload), newPayload);
      if (!configurationImported) throw new Error("新作品核心配置回读不一致");
      const archivedName = `${this.work.name}（已迁移 ${newWorkId.slice(-8)}）`.slice(0, 80);
      const oldPayload = modelConfigSavePayload(exported, this.work.id, archivedName, description);
      await this.requestConsole(`/apps/${encodeURIComponent(this.work.id)}/model-config`, { method: "POST", body: oldPayload, timeout: 30000 });
      const oldVerifiedPayload = await this.requestConsole(`/apps/${encodeURIComponent(this.work.id)}/model-config/export`, { timeout: 30000 });
      const oldVerified = exportedConfig(oldVerifiedPayload);
      oldWorkRenamed = String(oldVerified?.name ?? oldVerified?.app?.name ?? "") === archivedName;
      if (!oldWorkRenamed) throw new Error("旧作品改名后回读不一致");
    } catch (error) {
      importError = String(error?.message || error || "配置导入失败");
    }
    if (!configurationImported || !oldWorkRenamed) {
      this.pendingMigration = { workId: newWorkId, url: newWorkUrl, exportSha256: exportHash, configuration: exported, configurationImported, oldWorkRenamed, requiresConfigurationImport: !configurationImported, requiresPublish: true, importError };
      this.notify();
      return { ...this.pendingMigration };
    }
    const identity = await this.getIdentity();
    if (identity.signingPublicKey !== this.control.authoritySigningPublicKey) throw new Error("本机作者密钥与当前赛季权威密钥不一致");
    const oldWork = this.work;
    const oldControl = this.control;
    const newWork = { ...oldWork, id: newWorkId, name: this.work.name, description, url: newWorkUrl, authorAccountId: this.account().accountId };
    const newControlUnsigned = { ...oldControl, id: crypto.randomUUID(), workId: newWorkId, programHash: this.currentProgramHash(), updatedAt: this.now() };
    delete newControlUnsigned.signature;
    const newControl = signRecord(newControlUnsigned, identity.signingPrivateKey);
    try {
      this.work = newWork;
      this.control = newControl;
      await this.postRecord(newControl);
      await this.publishSnapshot();
      for (const accountId of Object.keys(this.world.players || {})) await this.publishPrivateVault(accountId);
    } catch (error) {
      this.work = oldWork;
      this.control = oldControl;
      this.pendingMigration = { workId: newWorkId, url: newWorkUrl, exportSha256: exportHash, configurationImported: true, oldWorkRenamed: true, newLedgerInitialized: false, redirectPublished: false, requiresPublish: true, importError: String(error?.message || error) };
      this.notify();
      return { ...this.pendingMigration };
    }
    this.work = oldWork;
    this.control = oldControl;
    const directive = signRecord(createResetDirective({ gameId: GRID_GAME_ID, seasonId: oldControl.seasonId, oldWorkId: oldWork.id, newWorkId, newWorkUrl, exportSha256: exportHash, issuedAt: this.now() }), identity.signingPrivateKey);
    await this.postRecord(directive);
    this.work = newWork;
    this.control = newControl;
    this.mapFactsCache = null;
    this.worldBookFingerprint = null;
    this.pendingMigration = { workId: newWorkId, url: newWorkUrl, exportSha256: exportHash, configurationImported: true, oldWorkRenamed: true, redirectPublished: true, requiresConfigurationImport: false, requiresPublish: true };
    this.saveCache();
    this.notify();
    return { ...this.pendingMigration };
  }
}

module.exports = { OnlineWorldService, workReference, normalizeWorkDetail, commentAccountId, parseJsonAnswer, HISTORY_PAGE_SIZE, MAX_HISTORY_PAGES };
