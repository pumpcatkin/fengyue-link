const crypto = require("node:crypto");
const fs = require("node:fs");
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
const { sealJson, openSealedJson } = require("./online-world-crypto.cjs");
const { parseProgram } = require("./online-world-runtime.cjs");
const { builtInGridProgram, validateGameCard, createExportedGameCard, summarizeGameCard } = require("./online-world-card.cjs");
const {
  GRID_GAME_ID,
  GRID_SIZE,
  staticCell,
  createWorld,
  resetPlayerState,
  settleWorld,
  applyIntent,
  buildGeneralGenerationRequest,
  buildPlayerProfileContextRequest,
  buildGeneralMemoryUpdateRequest,
  normalizedCharacterTags,
  projectWorldState,
  publicGeneralState
} = require("./grid-world-game.cjs");

const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 10000;
const POLL_INTERVAL_MS = 5000;
const DIRECT_RATE_WINDOW_MS = 60 * 1000;
const DIRECT_SEND_LIMIT = 12;
const DIRECT_RECEIVE_LIMIT_PER_SENDER = 20;
const PUBLIC_LEDGER_COMPACTION_DELTAS = 32;

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
  const matchesWork = item => String(item?.id || item?.app_id || item?.appId || "") === String(fallbackId);
  const authorId = item => item?.created_by_account_id || item?.author_account_id || item?.creator_account_id || item?.owner_account_id
    || item?.author?.id || item?.creator?.id || item?.owner?.id || item?.created_by?.id || item?.createdBy?.id || "";
  const authorDetail = firstObject(payload, item => matchesWork(item) && Boolean(authorId(item)));
  const namedDetail = firstObject(payload, item => matchesWork(item) && Boolean(item?.name || item?.title || item?.description || item?.desc));
  const detail = authorDetail || namedDetail || payload?.data?.app || payload?.app || payload?.data || payload;
  const author = detail?.author || detail?.creator || detail?.owner || detail?.created_by || detail?.createdBy || {};
  return {
    id: String(detail?.id || detail?.app_id || detail?.appId || fallbackId),
    name: String(detail?.name || detail?.title || "在线游戏世界"),
    description: String(detail?.description || detail?.desc || ""),
    authorAccountId: String(authorId(detail)),
    authorName: String(detail?.created_by_account_name || detail?.author_account_name || detail?.creator_account_name || detail?.owner_account_name || author?.name || author?.username || "")
  };
}

function programFromGameCard(card) {
  if (!card?.companion?.configuration?.app?.description) return null;
  try {
    const program = parseProgram(card.companion.configuration.app.description, String(card.gameId || GRID_GAME_ID));
    return program ? { ...program, source: "card-package" } : null;
  } catch {
    return null;
  }
}

function isVerifiedProgram(program) {
  return program?.source === "work-description" || program?.source === "card-package";
}

function commentId(value) {
  return String(value?.id || value?.comment_id || value?.data?.id || value?.data?.comment_id || value?.comment?.id || value?.data?.comment?.id || "");
}

function commentAccountId(value) {
  return String(value?.account_id || value?.accountId || value?.created_by_account_id || value?.from_account_id || value?.account?.id || value?.user?.id || value?.author?.id || value?.created_by?.id || value?.sender?.id || "");
}

function commentTimestamp(value) {
  const raw = value?.created_at ?? value?.createdAt ?? value?.create_time ?? value?.createTime
    ?? value?.published_at ?? value?.publishedAt ?? value?.timestamp ?? null;
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number" || /^\d+(?:\.\d+)?$/.test(String(raw))) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return numeric < 10_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function recordPlatformOrder(item) {
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  const timestamps = sources.map(commentTimestamp).filter(Boolean);
  return {
    timestamp: timestamps.length ? Math.max(...timestamps) : 0,
    commentId: sources.map(commentId).filter(Boolean).sort().at(-1) || ""
  };
}

function comparePlatformOrder(left, right) {
  const a = recordPlatformOrder(left);
  const b = recordPlatformOrder(right);
  return a.timestamp - b.timestamp || a.commentId.localeCompare(b.commentId);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeCharacterProfile(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: String(source.id || "").trim().slice(0, 100),
    label: String(source.label || "").trim().slice(0, 80),
    displayName: String(source.displayName || "玩家").trim().slice(0, 80) || "玩家",
    basicInfo: String(source.basicInfo || "").trim().slice(0, 6000),
    appearance: String(source.appearance || "").trim().slice(0, 3000),
    info: String(source.info || "").trim().slice(0, 9000)
  };
}

function validPosition(value) {
  return value?.x != null && value?.y != null
    && Number.isInteger(Number(value.x)) && Number(value.x) >= 0 && Number(value.x) < GRID_SIZE
    && Number.isInteger(Number(value.y)) && Number(value.y) >= 0 && Number(value.y) < GRID_SIZE;
}

function finiteStoredNumber(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function compareOrderValue(left, right) {
  return Number(left?.timestamp || 0) - Number(right?.timestamp || 0)
    || String(left?.commentId || "").localeCompare(String(right?.commentId || ""));
}

function publicCells(state) {
  return Object.fromEntries(Object.entries(state?.cells || {})
    .filter(([, cell]) => cell?.ownerAccountId || Number(cell?.soldiers || 0) || (cell?.generalIds || []).length)
    .map(([key, cell]) => [key, {
      ownerAccountId: cell.ownerAccountId ? String(cell.ownerAccountId) : null,
      soldiers: Math.max(0, Math.trunc(Number(cell.soldiers || 0))),
      generalIds: [...new Set((cell.generalIds || []).map(String))].slice(0, 2)
    }]));
}

function publicGenerals(state) {
  return Object.fromEntries(Object.entries(state?.generals || {})
    .filter(([, general]) => general?.status === "deployed")
    .map(([id, general]) => [id, publicGeneralState(general)]));
}

function cacheWorldWithoutDeployedArchives(state) {
  const cached = cloneJson(state);
  for (const [id, general] of Object.entries(cached?.generals || {})) {
    if (general?.status === "deployed") delete cached.generals[id];
  }
  return cached;
}

function changedEntries(before, after) {
  const changes = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const previous = Object.hasOwn(before || {}, key) ? before[key] : null;
    const next = Object.hasOwn(after || {}, key) ? after[key] : null;
    if (canonicalJson(previous) !== canonicalJson(next)) changes[key] = cloneJson(next);
  }
  return changes;
}

function createPublicMapChanges(beforeWorld, afterWorld) {
  return {
    cells: changedEntries(publicCells(beforeWorld), publicCells(afterWorld)),
    generals: changedEntries(publicGenerals(beforeWorld), publicGenerals(afterWorld))
  };
}

function hasPublicMapChanges(changes) {
  return Boolean(Object.keys(changes?.cells || {}).length || Object.keys(changes?.generals || {}).length);
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
  return firstObject(payload, item => ["world_book", "wbook", "lore_bk", "world_bk", "wb"].some(key => Object.hasOwn(item, key))
    && ["prpt", "ppt", "pre_pt", "prompt_pre", "pre_prompt"].some(key => Object.hasOwn(item, key)))
    || payload?.data || payload;
}

function modelConfigSavePayload(exported, workId, name, description) {
  const payload = JSON.parse(JSON.stringify(exported || {}));
  const firstString = (...values) => values.find(value => typeof value === "string") || "";
  const summary = String(payload.summary ?? payload.smry ?? payload.abs_txt ?? payload.sum_info ?? payload.abstract ?? payload.app?.summary ?? "在线游戏世界");
  payload.app = {
    ...(payload.app && typeof payload.app === "object" ? payload.app : {}),
    id: String(workId),
    name: String(name),
    description: String(description),
    summary,
    language: String(payload.lang ?? payload.locale ?? payload.lc ?? payload.lng ?? payload.language ?? payload.app?.language ?? "zh-Hans"),
    gender: Number(payload.gender ?? payload.ref_id2 ?? payload.app?.gender ?? 0),
    cover: firstString(payload.cover, payload.cover_url, payload.cvr_url, payload.app?.cover),
    cover_tiny: firstString(payload.cover_tiny, payload.cvr_tiny, payload.cover_sm, payload.app?.cover_tiny),
    is_anonymous: Boolean(payload.is_anonymous ?? payload.is_anon ?? payload.ianon ?? payload.anon ?? payload.app?.is_anonymous ?? false),
    update_content: "",
    mod_permission: Number(payload.mod_permission ?? payload.mod_perm ?? payload.mod_pm ?? payload.mperm ?? payload.app?.mod_permission ?? 0),
    disable_css_mod: Boolean(payload.disable_css_mod ?? payload.disable_cssmod ?? payload.dcm ?? payload.no_css_mod ?? payload.app?.disable_css_mod ?? false),
    is_available_not_public: Boolean(payload.is_available_not_public ?? payload.avail_not_pub ?? payload.is_avail_np ?? payload.avail_np ?? payload.ianp ?? payload.app?.is_available_not_public ?? false),
    schedule_publish_or_not: false
  };
  payload.pre_prompt = payload.pre_prompt ?? payload.prpt ?? payload.ppt ?? payload.pre_pt ?? payload.prompt_pre ?? "";
  payload.pre_text = payload.pre_text ?? payload.pretxt ?? payload.ptx ?? payload.pre_tx ?? payload.prefix_txt ?? "";
  payload.post_text = payload.post_text ?? payload.posttxt ?? payload.potx ?? payload.post_tx ?? payload.suffix_txt ?? "";
  payload.world_book = payload.world_book || payload.wbook || payload.lore_bk || payload.world_bk || payload.wb || [];
  return payload;
}

function coreConfigMatches(exported, expected) {
  const fields = value => ({
    description: String(value?.desc ?? value?.descr ?? value?.dsc ?? value?.intro ?? value?.description ?? value?.app?.description ?? ""),
    prePrompt: String(value?.prpt ?? value?.ppt ?? value?.pre_pt ?? value?.prompt_pre ?? value?.pre_prompt ?? ""),
    preText: String(value?.pretxt ?? value?.ptx ?? value?.pre_tx ?? value?.prefix_txt ?? value?.pre_text ?? ""),
    postText: String(value?.posttxt ?? value?.potx ?? value?.post_tx ?? value?.suffix_txt ?? value?.post_text ?? ""),
    worldBook: value?.world_book || value?.wbook || value?.lore_bk || value?.world_bk || value?.wb || []
  });
  return canonicalJson(fields(exported)) === canonicalJson(fields(expected));
}

function normalizeWorldState(value) {
  if (!value || typeof value !== "object") return value;
  value.cells ||= {};
  value.players ||= {};
  value.bans ||= {};
  value.playerEpochs ||= {};
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
    this.card = null;
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
    this.localEvents = [];
    this.localPreferences = { orientation: "any", characterProfileId: "", characterTags: [], initialGeneralWish: "", characterProfile: null, playerContext: null };
    this.appliedMapDeltaIds = new Set();
    this.appliedAuthorityIds = new Set();
    this.publicDeltaCountSinceSnapshot = 0;
    this.publicMapOrder = { timestamp: 0, commentId: "" };
    this.publicMapBaselineOrder = { timestamp: 0, commentId: "" };
    this.publicCellOrders = {};
    this.publicGeneralOrders = {};
    this.publicParticipantOrders = {};
    this.worldBookFingerprint = null;
    this.modelConversationId = "";
    this.modelRequestQueue = Promise.resolve();
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
      card: this.card ? summarizeGameCard(this.card) : null,
      work: this.work ? { ...this.work, description: undefined } : null,
      initialized: Boolean(this.control && this.world),
      isAuthor: Boolean(this.work?.authorAccountId && this.work.authorAccountId === this.account().accountId),
      isServerOwner: Boolean(this.work?.authorAccountId && this.work.authorAccountId === this.account().accountId),
      serverOwnerName: this.work?.authorName || null,
      isAuthority: this.isAuthority(),
      revision: Number(this.world?.revision || 0),
      lastSyncAt: this.lastSyncAt,
      history: { ...this.history },
      migration: this.pendingMigration ? { ...this.pendingMigration } : null,
      directInboxCount: this.directInbox.length,
      localEventCount: this.localEvents.length,
      publicDeltaCountSinceSnapshot: this.publicDeltaCountSinceSnapshot,
      clock: { source: this.lastClockCalibrationAt ? "platform-date" : "host", calibratedAt: this.lastClockCalibrationAt, offsetMs: Math.round(this.now() - this.rawNow()) },
      program: { source: this.program.source, digest: this.program.digest, title: this.program.manifest?.title || "猎艳疆土", apiVersion: this.program.manifest?.apiVersion || 1 }
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
      localPreferences: {
        orientation: this.localPreferences.orientation,
        characterProfileId: this.localPreferences.characterProfileId,
        characterTags: cloneJson(this.localPreferences.characterTags)
      },
      mapFacts: projection ? this.mapFactsCache : [],
      directInbox: this.directInbox.slice(-100),
      programHtml: this.program?.html || null,
      serverNow: this.now()
    };
  }

  notify() {
    try { this.onChange(this.state()); } catch {}
  }

  recordLocalEvent(event) {
    if (!event) return;
    this.localEvents.push(cloneJson(event));
    if (this.localEvents.length > 2000) this.localEvents.splice(0, this.localEvents.length - 2000);
  }

  captureLocalOverlay() {
    if (!this.world) return null;
    const accountId = this.account().accountId;
    const allowed = candidate => String(candidate) === accountId;
    return {
      playerEpoch: Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[accountId] || 0))),
      privatePlayers: Object.fromEntries(Object.entries(this.world.privatePlayers || {}).filter(([id]) => allowed(id)).map(([id, value]) => [id, cloneJson(value)])),
      players: Object.fromEntries(Object.entries(this.world.players || {}).filter(([id]) => allowed(id)).map(([id, player]) => [id, {
        ...(finiteStoredNumber(player.gold) ? { gold: Number(player.gold) } : {}),
        ...(finiteStoredNumber(player.fieldArmySoldiers) ? { fieldArmySoldiers: Number(player.fieldArmySoldiers) } : {}),
        ...(Object.hasOwn(player, "carriedGeneralIds") ? { carriedGeneralIds: [...(player.carriedGeneralIds || [])] } : {}),
        ...(validPosition(player.position) ? { position: { x: Number(player.position.x), y: Number(player.position.y) } } : {}),
        ...(finiteStoredNumber(player.joinedAt) ? { joinedAt: Number(player.joinedAt) } : {})
      }])),
      generals: Object.fromEntries(Object.entries(this.world.generals || {}).filter(([, general]) => general.status !== "deployed" && allowed(general.holderAccountId)).map(([id, general]) => [id, cloneJson(general)])),
      jobs: Object.fromEntries(Object.entries(this.world.jobs || {}).filter(([, job]) => allowed(job.accountId)).map(([id, job]) => [id, cloneJson(job)])),
      processedIntents: [...(this.world.processedIntents || [])]
    };
  }

  pruneForeignPrivateState() {
    if (!this.world) return;
    normalizeWorldState(this.world);
    const accountId = this.account().accountId;
    this.world.privatePlayers = Object.fromEntries(Object.entries(this.world.privatePlayers).filter(([id]) => id === accountId));
    this.world.jobs = Object.fromEntries(Object.entries(this.world.jobs).filter(([, job]) => String(job.accountId) === accountId));
    for (const [id, general] of Object.entries(this.world.generals)) {
      if (general.status !== "deployed" && String(general.holderAccountId) !== accountId) delete this.world.generals[id];
    }
    for (const [id, player] of Object.entries(this.world.players)) {
      if (id === accountId) continue;
      delete player.gold;
      delete player.fieldArmySoldiers;
      delete player.carriedGeneralIds;
      delete player.position;
    }
  }

  restoreLocalOverlay(overlay) {
    if (!this.world) return;
    normalizeWorldState(this.world);
    const accountId = this.account().accountId;
    const currentEpoch = Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[accountId] || 0)));
    if (overlay && Math.max(0, Math.trunc(Number(overlay.playerEpoch || 0))) !== currentEpoch) {
      this.clearResetLocalPlayer(accountId);
      overlay = null;
    }
    if (overlay) {
      Object.assign(this.world.privatePlayers, overlay.privatePlayers || {});
      for (const [accountId, fields] of Object.entries(overlay.players || {})) if (this.world.players[accountId]) Object.assign(this.world.players[accountId], fields);
      Object.assign(this.world.generals, overlay.generals || {});
      Object.assign(this.world.jobs, overlay.jobs || {});
      this.world.processedIntents = [...new Set([...(this.world.processedIntents || []), ...(overlay.processedIntents || [])])].slice(-1000);
    }
    if (accountId && this.world.players[accountId]) {
      this.world.privatePlayers[accountId] ||= {};
      this.world.privatePlayers[accountId].orientation = this.localPreferences.orientation;
      this.world.privatePlayers[accountId].characterProfileId = this.localPreferences.characterProfileId;
      this.world.privatePlayers[accountId].characterTags = [...this.localPreferences.characterTags];
      this.world.privatePlayers[accountId].initialGeneralWish = this.localPreferences.initialGeneralWish;
      this.world.privatePlayers[accountId].playerContext = cloneJson(this.localPreferences.playerContext);
    }
    this.recoverOwnLocalPlayerState();
    this.pruneForeignPrivateState();
  }

  recoverOwnLocalPlayerState() {
    if (!this.world) return false;
    const accountId = this.account().accountId;
    const player = this.world.players?.[accountId];
    if (!accountId || !player) return false;
    const ownEvents = (this.localEvents || []).filter(event => String(event?.actorAccountId || event?.intent?.actorAccountId || "") === accountId);
    const joinEvent = [...ownEvents].reverse().find(event => event?.type === "join" && validPosition(event?.result?.capital));
    const coreStateWasIncomplete = !validPosition(player.position);
    let changed = false;
    if (!validPosition(player.position)) {
      let recovered = null;
      for (const event of [...ownEvents].reverse()) {
        const effects = event?.type === "time-settle" && Array.isArray(event?.result?.effects) ? [...event.result.effects].reverse() : [];
        const movement = effects.find(effect => String(effect?.accountId || "") === accountId && validPosition(effect?.at) && ["march-arrived", "battle-won"].includes(effect.type));
        const returned = effects.find(effect => String(effect?.accountId || "") === accountId && validPosition(effect?.returnedTo));
        if (movement || returned) { recovered = movement?.at || returned.returnedTo; break; }
      }
      if (!recovered) recovered = joinEvent?.result?.capital || null;
      if (!recovered) {
        const ownedKey = Object.entries(this.world.cells || {}).find(([, cell]) => String(cell?.ownerAccountId || "") === accountId)?.[0];
        if (ownedKey) { const [x, y] = ownedKey.split(",").map(Number); recovered = { x, y }; }
      }
      if (validPosition(recovered)) { player.position = { x: Number(recovered.x), y: Number(recovered.y) }; changed = true; }
    }
    if (!finiteStoredNumber(player.gold) || coreStateWasIncomplete) {
      let gold = Number(joinEvent?.result?.gold);
      if (!Number.isFinite(gold)) gold = 0;
      const start = joinEvent ? ownEvents.indexOf(joinEvent) + 1 : 0;
      for (const event of ownEvents.slice(start)) {
        if (["train", "march"].includes(event?.type)) gold -= Math.max(0, Number(event?.result?.cost || 0));
        if (event?.type === "time-settle") for (const effect of event?.result?.effects || []) {
          if (effect?.type === "mining-complete" && String(effect.accountId || "") === accountId) gold += Math.max(0, Number(effect.gold || 0));
        }
      }
      player.gold = Math.max(0, gold); changed = true;
    }
    if (!finiteStoredNumber(player.fieldArmySoldiers)) { player.fieldArmySoldiers = 0; changed = true; }
    if (!Array.isArray(player.carriedGeneralIds)) {
      player.carriedGeneralIds = Object.entries(this.world.generals || {})
        .filter(([, general]) => String(general?.holderAccountId || "") === accountId && general?.status === "carried")
        .map(([id]) => id).slice(0, 2);
      changed = true;
    }
    if (!finiteStoredNumber(player.joinedAt) && joinEvent) { player.joinedAt = Number(joinEvent.createdAt || this.world.startedAt || this.now()); changed = true; }
    return changed;
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
    root.worlds[this.work.id] = {
      control: this.control,
      world: cacheWorldWithoutDeployedArchives(this.world),
      localOverlay: this.captureLocalOverlay(),
      publicArchivesRequireRefresh: true,
      localEvents: this.localEvents.slice(-2000),
      appliedMapDeltaIds: [...this.appliedMapDeltaIds].slice(-4000),
      appliedAuthorityIds: [...this.appliedAuthorityIds].slice(-1000),
      publicDeltaCountSinceSnapshot: this.publicDeltaCountSinceSnapshot,
      publicMapOrder: { ...this.publicMapOrder },
      publicMapBaselineOrder: { ...this.publicMapBaselineOrder },
      publicCellOrders: this.publicCellOrders,
      publicGeneralOrders: this.publicGeneralOrders,
      publicParticipantOrders: this.publicParticipantOrders,
      modelConversationId: this.modelConversationId,
      directInbox: this.directInbox.slice(-100),
      localPreferences: cloneJson(this.localPreferences),
      seenDirectMessageIds: [...this.seenDirectMessageIds].slice(-500),
      updatedAt: this.now()
    };
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

  async open({ card, workUrl, orientation, displayName } = {}) {
    const account = this.account();
    if (!account.accountId) throw new Error("请先登录风月账号");
    const origin = String(this.getOrigin?.() || "").replace(/\/$/, "");
    const normalizedCard = card ? validateGameCard(card) : null;
    const fixedWorkUrl = normalizedCard ? `${origin}/zh/explore/installed/${encodeURIComponent(normalizedCard.companion.workId)}` : workUrl;
    const reference = workReference(fixedWorkUrl, origin);
    if (normalizedCard && reference.workId !== normalizedCard.companion.workId) throw new Error("游戏卡绑定的伴生作品编号不一致");
    this.status = "opening";
    this.error = null;
    this.notify();
    await this.calibrateClock().catch(() => null);
    const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(reference.workId)}`);
    this.card = normalizedCard;
    this.work = { ...normalizeWorkDetail(payload, reference.workId), url: reference.url };
    if (normalizedCard?.companion?.authorAccountId && this.work.authorAccountId !== normalizedCard.companion.authorAccountId) throw new Error("伴生作品当前作者与游戏卡绑定的服主账号不一致");
    if (normalizedCard && this.work.name === "在线游戏世界") this.work.name = normalizedCard.companion.name;
    this.program = parseProgram(this.work.description, GRID_GAME_ID) || programFromGameCard(normalizedCard) || builtInGridProgram();
    this.mapFactsCache = null;
    const cached = this.loadCache(this.work.id);
    this.localEvents = Array.isArray(cached?.localEvents) ? cached.localEvents.slice(-2000) : [];
    this.appliedMapDeltaIds = new Set(Array.isArray(cached?.appliedMapDeltaIds) ? cached.appliedMapDeltaIds.slice(-4000) : []);
    this.appliedAuthorityIds = new Set(Array.isArray(cached?.appliedAuthorityIds) ? cached.appliedAuthorityIds.slice(-1000) : []);
    this.publicDeltaCountSinceSnapshot = Math.max(0, Number(cached?.publicDeltaCountSinceSnapshot || 0));
    this.publicMapOrder = {
      timestamp: Number(cached?.publicMapOrder?.timestamp || 0),
      commentId: String(cached?.publicMapOrder?.commentId || "")
    };
    this.publicMapBaselineOrder = {
      timestamp: Number(cached?.publicMapBaselineOrder?.timestamp || 0),
      commentId: String(cached?.publicMapBaselineOrder?.commentId || "")
    };
    this.publicCellOrders = cached?.publicCellOrders && typeof cached.publicCellOrders === "object" ? cached.publicCellOrders : {};
    this.publicGeneralOrders = cached?.publicGeneralOrders && typeof cached.publicGeneralOrders === "object" ? cached.publicGeneralOrders : {};
    this.publicParticipantOrders = cached?.publicParticipantOrders && typeof cached.publicParticipantOrders === "object" ? cached.publicParticipantOrders : {};
    this.modelConversationId = String(cached?.modelConversationId || "").trim().slice(0, 200);
    this.localPreferences = {
      orientation: ["men", "women", "any"].includes(cached?.localPreferences?.orientation)
        ? cached.localPreferences.orientation
        : (["men", "women", "any"].includes(orientation) ? orientation : "any"),
      characterProfileId: String(cached?.localPreferences?.characterProfileId || ""),
      characterTags: Array.isArray(cached?.localPreferences?.characterTags) ? cached.localPreferences.characterTags.map(String).slice(0, 80) : [],
      initialGeneralWish: String(cached?.localPreferences?.initialGeneralWish || "").slice(0, 500),
      characterProfile: cached?.localPreferences?.characterProfile ? normalizeCharacterProfile(cached.localPreferences.characterProfile) : null,
      playerContext: cached?.localPreferences?.playerContext && typeof cached.localPreferences.playerContext === "object" ? cloneJson(cached.localPreferences.playerContext) : null
    };
    if (cached?.publicArchivesRequireRefresh) {
      this.appliedMapDeltaIds.clear();
      this.appliedAuthorityIds.clear();
      this.publicDeltaCountSinceSnapshot = 0;
      this.publicMapOrder = { timestamp: 0, commentId: "" };
      this.publicMapBaselineOrder = { timestamp: 0, commentId: "" };
      this.publicCellOrders = {};
      this.publicGeneralOrders = {};
      this.publicParticipantOrders = {};
    }
    if (cached?.world?.gameId === GRID_GAME_ID) {
      this.control = cached.control || null;
      this.world = normalizeWorldState(cached.world);
      this.restoreLocalOverlay(cached.localOverlay || null);
      this.directInbox = Array.isArray(cached.directInbox) ? cached.directInbox.slice(-100) : [];
      this.seenDirectMessageIds = new Set(Array.isArray(cached.seenDirectMessageIds) ? cached.seenDirectMessageIds : this.directInbox.map(item => item.messageId));
    } else {
      this.control = null;
      this.world = null;
    }
    this.pendingJoin = {
      orientation: this.localPreferences.orientation,
      displayName: String(displayName || account.username || "玩家").slice(0, 40)
    };
    await this.sync(true);
    this.status = this.control && this.world ? "ready" : "needs-initialization";
    this.startPolling();
    this.notify();
    return this.state();
  }

  async exportGameCard() {
    if (!this.card || !this.work) throw new Error("请先打开一张游戏卡");
    if (this.account().accountId !== this.work.authorAccountId) throw new Error("只有伴生作品作者可以导出包含创作页的完整游戏卡");
    const payload = await this.requestConsole(`/apps/${encodeURIComponent(this.work.id)}/model-config/export`, { timeout: 30000 });
    const exported = exportedConfig(payload);
    return createExportedGameCard(this.card, exported);
  }

  async refreshWorkProgram() {
    if (!this.work) return null;
    const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(this.work.id)}`);
    this.work = { ...normalizeWorkDetail(payload, this.work.id), url: this.work.url };
    this.program = parseProgram(this.work.description, GRID_GAME_ID) || programFromGameCard(this.card) || builtInGridProgram();
    return this.program;
  }

  async initialize() {
    if (!this.work) throw new Error("请先选择伴生作品");
    if (!isVerifiedProgram(this.program)) throw new Error("游戏卡中尚未包含有效游戏程序包");
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
    for (const content of encodeCommentRecord(record)) {
      const response = await this.postComment(content, options);
      const source = firstObject(response, item => Boolean(commentId(item))) || response || {};
      responses.push({
        ...(source && typeof source === "object" ? source : {}),
        id: commentId(source) || commentId(response),
        account_id: commentAccountId(source) || commentAccountId(response) || this.account().accountId,
        content
      });
    }
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

  validMapDelta(item) {
    const record = item?.record;
    if (record?.schema !== FYOW_SCHEMAS.mapDelta || record.seasonId !== this.control?.seasonId || record.workId !== this.work?.id || record.gameId !== GRID_GAME_ID) return false;
    const actorAccountId = String(record.actorAccountId || "");
    if (!actorAccountId || !record.deviceSigningPublicKey || !verifySignedRecord(record, record.deviceSigningPublicKey)) return false;
    const order = recordPlatformOrder(item);
    if (!(item.sources || []).some(source => commentAccountId(source) === actorAccountId) || !order.timestamp) return false;
    const currentEpoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[actorAccountId] || 0)));
    if (Math.max(0, Math.trunc(Number(record.playerEpoch || 0))) !== currentEpoch) return false;
    if (this.world?.bans?.[actorAccountId]?.banned) return false;
    const cells = record.changes?.cells;
    const generals = record.changes?.generals;
    if (!cells || typeof cells !== "object" || Array.isArray(cells) || !generals || typeof generals !== "object" || Array.isArray(generals)) return false;
    if (Object.keys(cells).length > GRID_SIZE * GRID_SIZE || Object.keys(generals).length > 100) return false;
    for (const [key, cell] of Object.entries(cells)) {
      const match = key.match(/^(\d+),(\d+)$/);
      if (!match) return false;
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
      if (cell == null) continue;
      if (String(cell.ownerAccountId || "") !== actorAccountId) return false;
      if (!Number.isSafeInteger(Number(cell.soldiers)) || Number(cell.soldiers) < 0 || Number(cell.soldiers) > staticCell(this.world.seed, x, y).garrisonCap) return false;
      if (!Array.isArray(cell.generalIds) || cell.generalIds.length > 2 || new Set(cell.generalIds.map(String)).size !== cell.generalIds.length) return false;
    }
    for (const general of Object.values(generals)) {
      if (general == null) continue;
      if (general.status !== "deployed" || !general.id || !general.location || String(general.holderAccountId || "") !== actorAccountId) return false;
      if (JSON.stringify(general).length > 30000 || String(general.setting || "").length > 1000 || String(general.memoryText || "").length > 1000) return false;
      if (Array.isArray(general.interactionHistory) && general.interactionHistory.length > 40) return false;
      if (Array.isArray(general.masterHistory) && general.masterHistory.length > 20) return false;
      if (Array.isArray(general.captivityHistory) && general.captivityHistory.length > 20) return false;
      const x = Number(general.location.x);
      const y = Number(general.location.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
    }
    return true;
  }

  validAuthorityDirective(item) {
    const record = item?.record;
    if (record?.schema !== FYOW_SCHEMAS.authority || record.gameId !== GRID_GAME_ID || record.workId !== this.work?.id || record.seasonId !== this.control?.seasonId) return false;
    if (!this.work?.authorAccountId || String(record.authorityAccountId || "") !== this.work.authorAccountId || String(this.control?.authorityAccountId || "") !== this.work.authorAccountId) return false;
    if (!this.validAuthorSource(item) || !recordPlatformOrder(item).timestamp || !verifySignedRecord(record, this.control.authoritySigningPublicKey)) return false;
    if (!["player-reset", "player-ban", "player-unban"].includes(String(record.type || ""))) return false;
    return Boolean(String(record.targetAccountId || "").trim());
  }

  clearResetLocalPlayer(targetAccountId) {
    if (String(targetAccountId) !== this.account().accountId) return;
    this.localEvents = [];
    this.localPreferences = { orientation: "any", characterProfileId: "", characterTags: [], initialGeneralWish: "", characterProfile: null, playerContext: null };
    this.directInbox = [];
    this.seenDirectMessageIds.clear();
    this.worldBookFingerprint = null;
    this.modelConversationId = "";
  }

  applyAuthorityDirective(item) {
    if (!this.validAuthorityDirective(item)) return false;
    const record = item.record;
    const id = String(record.authorityId || record.id || "");
    const order = recordPlatformOrder(item);
    if (!id || this.appliedAuthorityIds.has(id) || compareOrderValue(order, this.publicMapBaselineOrder) <= 0) return false;
    normalizeWorldState(this.world);
    const target = String(record.targetAccountId);
    if (record.type === "player-reset") {
      const ownedCells = Object.entries(this.world.cells).filter(([, cell]) => String(cell?.ownerAccountId || "") === target).map(([key]) => key);
      const ownedGenerals = Object.entries(this.world.generals).filter(([, general]) => String(general?.holderAccountId || "") === target).map(([generalId]) => generalId);
      resetPlayerState(this.world, target, Number(record.playerEpoch));
      for (const key of ownedCells) this.publicCellOrders[key] = order;
      for (const generalId of ownedGenerals) this.publicGeneralOrders[generalId] = order;
      this.publicParticipantOrders[target] = order;
      this.clearResetLocalPlayer(target);
    } else {
      const previous = this.world.bans[target] || {};
      this.world.bans[target] = {
        accountId: target,
        accountName: String(record.targetAccountName || previous.accountName || target).slice(0, 80),
        displayName: String(record.targetDisplayName || previous.displayName || this.world.players[target]?.displayName || target).slice(0, 40),
        banned: record.type === "player-ban",
        issuedAt: Number(record.issuedAt || 0),
        authorityId: id
      };
    }
    this.world.revision = Number(this.world.revision || 0) + 1;
    this.appliedAuthorityIds.add(id);
    if (this.appliedAuthorityIds.size > 1000) this.appliedAuthorityIds = new Set([...this.appliedAuthorityIds].slice(-1000));
    if (compareOrderValue(order, this.publicMapOrder) > 0) this.publicMapOrder = order;
    return true;
  }

  applyMapDelta(item) {
    if (!this.validMapDelta(item)) return false;
    const record = item.record;
    const actorAccountId = String(record.actorAccountId);
    const order = recordPlatformOrder(item);
    if (this.appliedMapDeltaIds.has(String(record.mapDeltaId)) || compareOrderValue(order, this.publicMapBaselineOrder) <= 0) return false;
    for (const [key, cell] of Object.entries(record.changes.cells)) {
      if (compareOrderValue(order, this.publicCellOrders[key] || this.publicMapBaselineOrder) <= 0) continue;
      if (cell == null) {
        if (this.world.cells[key]?.ownerAccountId !== actorAccountId) continue;
        delete this.world.cells[key];
      }
      else this.world.cells[key] = cloneJson(cell);
      this.publicCellOrders[key] = order;
    }
    for (const [id, general] of Object.entries(record.changes.generals)) {
      if (compareOrderValue(order, this.publicGeneralOrders[id] || this.publicMapBaselineOrder) <= 0) continue;
      if (general == null) {
        const existing = this.world.generals[id];
        const locationKey = existing?.location ? `${existing.location.x},${existing.location.y}` : "";
        const conqueredLocation = locationKey && String(record.changes.cells?.[locationKey]?.ownerAccountId || "") === actorAccountId;
        if (existing?.holderAccountId !== actorAccountId && !conqueredLocation) continue;
        delete this.world.generals[id];
      }
      else this.world.generals[id] = publicGeneralState(general);
      this.publicGeneralOrders[id] = order;
    }
    if (compareOrderValue(order, this.publicParticipantOrders[actorAccountId] || this.publicMapBaselineOrder) > 0) {
      const existing = this.world.players[actorAccountId] || { accountId: actorAccountId };
      this.world.players[actorAccountId] = {
        ...existing,
        accountId: actorAccountId,
        accountName: String(record.participant?.accountName || existing.accountName || actorAccountId).slice(0, 80),
        displayName: String(record.participant?.displayName || existing.displayName || actorAccountId).slice(0, 40),
        deviceSigningPublicKey: record.deviceSigningPublicKey,
        deviceEncryptionPublicKey: record.deviceEncryptionPublicKey,
        commentRootId: existing.commentRootId || item.sources.map(commentId).filter(Boolean).sort()[0] || null
      };
      if (actorAccountId !== this.account().accountId) delete this.world.players[actorAccountId].position;
      this.publicParticipantOrders[actorAccountId] = order;
    }
    this.world.revision = Number(this.world.revision || 0) + 1;
    this.appliedMapDeltaIds.add(String(record.mapDeltaId));
    if (this.appliedMapDeltaIds.size > 4000) this.appliedMapDeltaIds = new Set([...this.appliedMapDeltaIds].slice(-4000));
    this.publicMapOrder = order;
    this.publicDeltaCountSinceSnapshot += 1;
    return true;
  }

  applyMapDeltas(records) {
    return records
      .filter(item => item.record?.schema === FYOW_SCHEMAS.mapDelta)
      .sort(comparePlatformOrder)
      .reduce((count, item) => count + Number(this.applyMapDelta(item)), 0);
  }

  applyPublicLedger(records) {
    return records
      .filter(item => [FYOW_SCHEMAS.mapDelta, FYOW_SCHEMAS.authority].includes(item.record?.schema))
      .sort(comparePlatformOrder)
      .reduce((count, item) => count + Number(item.record.schema === FYOW_SCHEMAS.authority
        ? this.applyAuthorityDirective(item)
        : this.applyMapDelta(item)), 0);
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
        .filter(item => String(item.record.authorityAccountId || "") === this.work.authorAccountId)
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
          .sort((left, right) => comparePlatformOrder(right, left));
        const snapshotItem = snapshots[0];
        const snapshot = snapshotItem?.record;
        const snapshotOrder = recordPlatformOrder(snapshotItem);
        const snapshotIsNewer = snapshot && (!this.world || compareOrderValue(snapshotOrder, this.publicMapOrder) > 0);
        if (snapshotIsNewer) {
          const localOverlay = this.captureLocalOverlay();
          this.world = normalizeWorldState(cloneJson(snapshot.state));
          this.restoreLocalOverlay(localOverlay);
          this.publicMapOrder = snapshotOrder;
          this.publicMapBaselineOrder = snapshotOrder;
          this.appliedMapDeltaIds.clear();
          this.appliedAuthorityIds.clear();
          this.publicDeltaCountSinceSnapshot = 0;
          this.publicCellOrders = {};
          this.publicGeneralOrders = {};
          this.publicParticipantOrders = {};
        }
        normalizeWorldState(this.world);
        if (this.world) this.applyPublicLedger(history.assembled.records);
        if (this.world) this.recoverOwnLocalPlayerState();
        if (this.world) await this.settleLocalClock();
        if (this.world && this.isAuthority() && this.publicDeltaCountSinceSnapshot >= PUBLIC_LEDGER_COMPACTION_DELTAS) await this.publishSnapshot();
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

  async submitIntent(intent = {}) {
    if (!this.control || !this.world) throw new Error("本赛季尚未初始化");
    const account = this.account();
    if (this.world?.bans?.[account.accountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁，所有游戏操作均会被忽略");
    if (this.recoverOwnLocalPlayerState()) this.saveCache();
    const normalized = { ...intent, idempotencyKey: String(intent.idempotencyKey || crypto.randomUUID()) };
    const previousPreferences = cloneJson(this.localPreferences);
    if (normalized.type === "join") {
      const orientation = ["men", "women", "any"].includes(normalized.orientation) ? normalized.orientation : this.pendingJoin?.orientation;
      this.localPreferences.orientation = orientation;
      this.localPreferences.characterProfileId = String(normalized.characterProfileId || "").slice(0, 100);
      this.localPreferences.characterTags = normalizedCharacterTags(normalized.characterTags);
      this.localPreferences.initialGeneralWish = String(normalized.initialGeneralWish || "").slice(0, 500);
      this.localPreferences.characterProfile = normalizeCharacterProfile(normalized.characterProfile || { id: normalized.characterProfileId, displayName: normalized.displayName });
      normalized.orientation = orientation;
    }
    try {
      if (normalized.type === "join") {
        const parsed = await this.requestStructuredModel(
          buildPlayerProfileContextRequest(this.localPreferences.characterProfile, `player-context:${normalized.idempotencyKey}`),
          { attempts: 3, label: "玩家角色设定整理" }
        );
        const personaSummary = String(parsed?.personaSummary || "").trim();
        const appearanceSummary = String(parsed?.appearanceSummary || "").trim();
        const speechStyle = String(parsed?.speechStyle || "").trim();
        const relationshipApproach = String(parsed?.relationshipApproach || "").trim();
        if (!personaSummary || personaSummary.length > 2000 || appearanceSummary.length > 1000 || speechStyle.length > 500 || relationshipApproach.length > 800) throw new Error("玩家角色设定世界书返回不完整");
        this.localPreferences.playerContext = {
          displayName: this.localPreferences.characterProfile.displayName,
          personaSummary,
          appearanceSummary,
          speechStyle,
          relationshipApproach
        };
        normalized.playerContext = cloneJson(this.localPreferences.playerContext);
        this.worldBookFingerprint = null;
      }
      return await this.applyLocalIntent(normalized, account.accountId, { rollbackPreferences: normalized.type === "join" ? previousPreferences : null });
    } catch (error) {
      if (normalized.type === "join") {
        this.localPreferences = previousPreferences;
        this.saveCache();
      }
      throw error;
    }
  }

  sanitizedEvent(event) {
    if (event.type === "talk-general") return { ...event, result: { generalId: event.result.generalId, modelRequested: true } };
    if (event.type === "grant-general") return { ...event, result: { generalGranted: true } };
    return event;
  }

  async publishMapChanges(changes, identity) {
    if (!hasPublicMapChanges(changes)) return null;
    const actor = this.world.players?.[this.account().accountId];
    const record = signRecord({
      schema: FYOW_SCHEMAS.mapDelta,
      mapDeltaId: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      actorAccountId: this.account().accountId,
      participant: {
        displayName: String(actor?.displayName || this.account().username || "玩家").slice(0, 40),
        accountName: String(this.account().username || this.account().accountId).slice(0, 80)
      },
      playerEpoch: Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[this.account().accountId] || 0))),
      changes,
      deviceSigningPublicKey: identity.signingPublicKey,
      deviceEncryptionPublicKey: identity.encryptionPublicKey
    }, identity.signingPrivateKey);
    const sources = await this.postRecord(record);
    const order = recordPlatformOrder({ sources });
    const rootId = sources.map(commentId).filter(Boolean).sort()[0] || null;
    if (actor && rootId && !actor.commentRootId) actor.commentRootId = rootId;
    this.appliedMapDeltaIds.add(record.mapDeltaId);
    this.publicDeltaCountSinceSnapshot += 1;
    if (order.timestamp) {
      for (const key of Object.keys(changes.cells || {})) this.publicCellOrders[key] = order;
      for (const id of Object.keys(changes.generals || {})) this.publicGeneralOrders[id] = order;
      this.publicParticipantOrders[this.account().accountId] = order;
      if (compareOrderValue(order, this.publicMapOrder) > 0) this.publicMapOrder = order;
    }
    return record;
  }

  async applyLocalIntent(intent, actorAccountId, options = {}) {
    if (String(actorAccountId) !== this.account().accountId) throw new Error("只能在本机执行当前玩家的行动");
    const identity = await this.getIdentity();
    const actionTime = this.now();
    const beforeWorld = cloneJson(this.world);
    const outcome = applyIntent(this.world, intent, { actorAccountId, actorAccountName: this.account().username, authorityAccountId: this.control.authorityAccountId, now: actionTime });
    if (outcome.duplicate) return { duplicate: true, state: this.state() };
    this.world = outcome.state;
    if (intent.type === "join") {
      const player = this.world.players[actorAccountId];
      player.accountName = this.account().username;
      player.deviceSigningPublicKey = identity.signingPublicKey;
      player.deviceEncryptionPublicKey = identity.encryptionPublicKey;
    }
    const localEvent = this.sanitizedEvent(outcome.event);
    const localEventStart = this.localEvents.length;
    this.recordLocalEvent(localEvent);
    try {
      await this.handleWorldBookTransition(intent, outcome, actorAccountId);
      let dialogue = null;
      if (outcome.result?.modelRequest) dialogue = await this.completeDialogue(outcome.result.modelRequest, actorAccountId, intent);
      // A join is committed only after its initial general has been returned
      // and validated by the companion model.
      if (intent.type === "join") await this.handleEffects(outcome.effects, identity);
      const changes = createPublicMapChanges(beforeWorld, this.world);
      const mapDelta = await this.publishMapChanges(changes, identity);
      if (intent.type !== "join") await this.handleEffects(outcome.effects, identity);
      if (this.isAuthority() && this.publicDeltaCountSinceSnapshot >= PUBLIC_LEDGER_COMPACTION_DELTAS) await this.publishSnapshot();
      this.saveCache();
      this.notify();
      return { event: localEvent, mapDelta, effects: outcome.effects, dialogue, state: this.state() };
    } catch (error) {
      if (intent.type === "join") {
        this.world = beforeWorld;
        if (options.rollbackPreferences) this.localPreferences = cloneJson(options.rollbackPreferences);
        this.localEvents.splice(localEventStart);
        this.worldBookFingerprint = null;
        this.saveCache();
        this.notify();
      }
      throw error;
    }
  }

  async settleLocalClock() {
    if (!this.world) return [];
    const beforeWorld = cloneJson(this.world);
    const settled = settleWorld(this.world, this.now());
    if (!settled.effects.length) return [];
    this.world = normalizeWorldState(settled.state);
    this.world.revision = Number(this.world.revision || 0) + 1;
    const event = {
      schema: FYOW_SCHEMAS.event,
      eventId: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      revision: this.world.revision,
      actorAccountId: this.account().accountId,
      type: "time-settle",
      result: { effects: settled.effects },
      createdAt: settled.now
    };
    this.recordLocalEvent(event);
    const identity = await this.getIdentity();
    await this.publishMapChanges(createPublicMapChanges(beforeWorld, this.world), identity);
    await this.handleEffects(settled.effects, identity);
    this.saveCache();
    return settled.effects;
  }

  async updateLocalPreferences(value = {}) {
    if (!this.world || !this.control) throw new Error("请先进入在线游戏世界");
    const accountId = this.account().accountId;
    if (!accountId) throw new Error("请先登录风月账号");
    if (this.world.bans?.[accountId]?.banned) throw new Error("该风月账号已被服主封禁");
    const orientation = ["men", "women", "any"].includes(String(value.orientation || "")) ? String(value.orientation) : this.localPreferences.orientation;
    const characterTags = normalizedCharacterTags(value.characterTags ?? this.localPreferences.characterTags);
    if (!characterTags.length) throw new Error("请至少添加一个性癖标签");
    this.localPreferences.orientation = orientation;
    this.localPreferences.characterTags = characterTags;
    if (this.world.privatePlayers?.[accountId]) {
      this.world.privatePlayers[accountId].orientation = orientation;
      this.world.privatePlayers[accountId].characterTags = [...characterTags];
    }
    this.saveCache();
    this.notify();
    return this.state();
  }

  async requestStructuredModel(request, { attempts = 2, label = "模型请求" } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        const answer = await this.requestModel({ ...request, conversationId: String(request?.conversationId || this.modelConversationId || "") });
        const conversationId = String(answer?.conversationId || answer?.conversation_id || "").trim();
        if (conversationId) this.modelConversationId = conversationId.slice(0, 200);
        return parseJsonAnswer(answer?.answer ?? answer);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
    throw new Error(`${label}未返回有效结构化结果：${lastError?.message || String(lastError || "未知错误")}`);
  }

  async administer(command = {}) {
    if (!this.work || !this.control || !this.world) throw new Error("请先开启在线游戏服务器");
    const account = this.account();
    if (!this.work.authorAccountId || account.accountId !== this.work.authorAccountId || !this.isAuthority()) throw new Error("服主指令仅对伴生作品作者开放");
    const type = String(command.type || "");
    if (!["player-reset", "player-ban", "player-unban"].includes(type)) throw new Error("未知服主指令");
    const targetAccountId = String(command.targetAccountId || "").trim();
    if (!targetAccountId) throw new Error("请选择目标玩家");
    const player = this.world.players?.[targetAccountId];
    const ban = this.world.bans?.[targetAccountId];
    if (!player && !ban) throw new Error("目标账号没有加入过当前服务器");
    const identity = await this.getIdentity();
    if (identity.signingPublicKey !== this.control.authoritySigningPublicKey) throw new Error("当前设备不是本赛季登记的作者设备");
    const authorityId = crypto.randomUUID();
    const record = signRecord({
      schema: FYOW_SCHEMAS.authority,
      authorityId,
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      authorityAccountId: account.accountId,
      type,
      targetAccountId,
      targetDisplayName: String(player?.displayName || ban?.displayName || targetAccountId).slice(0, 40),
      targetAccountName: String(player?.accountName || ban?.accountName || targetAccountId).slice(0, 80),
      ...(type === "player-reset" ? { playerEpoch: Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[targetAccountId] || 0))) + 1 } : {}),
      issuedAt: this.now()
    }, identity.signingPrivateKey);
    const sources = await this.postRecord(record);
    if (!this.applyAuthorityDirective({ record, sources })) throw new Error("服主指令发布后未通过作者身份与时间戳校验");
    await this.publishSnapshot();
    await this.reconcileOwnGeneralWorldBooks();
    this.saveCache();
    this.notify();
    return { command: { type, targetAccountId, authorityId }, state: this.state() };
  }

  async publishSnapshot() {
    const identity = await this.getIdentity();
    const state = projectWorldState(this.world, null);
    const snapshotId = crypto.randomUUID();
    const snapshot = signRecord({
      schema: FYOW_SCHEMAS.snapshot,
      snapshotId,
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      revision: Number(this.world.revision || 0),
      state,
      stateHash: sha256(Buffer.from(canonicalJson(state))),
      createdAt: this.now()
    }, identity.signingPrivateKey);
    const sources = await this.postRecord(snapshot);
    const order = recordPlatformOrder({ sources });
    if (order.timestamp) {
      this.publicMapOrder = order;
      this.publicMapBaselineOrder = order;
      this.appliedMapDeltaIds.clear();
      this.appliedAuthorityIds.clear();
      this.publicCellOrders = {};
      this.publicGeneralOrders = {};
      this.publicParticipantOrders = {};
      this.publicDeltaCountSinceSnapshot = 0;
    }
    return snapshot;
  }

  async handleEffects(effects, identity) {
    for (const effect of effects || []) {
      if (effect.type !== "general-generation-request") continue;
      const request = buildGeneralGenerationRequest(this.world, effect, crypto.randomUUID());
      const parsed = await this.requestStructuredModel(request, { attempts: effect.initial ? 3 : 2, label: effect.initial ? "初始将领生成" : "将领生成" });
      const name = String(parsed?.name || "").trim();
      const setting = String(parsed?.setting || "").trim();
      const gender = String(parsed?.gender || "").toLowerCase();
      const power = Number(parsed?.power);
      if (!name || name.length > 24 || !setting || setting.length > 1000 || !["male", "female"].includes(gender) || gender !== effect.gender || !Number.isInteger(power) || power < 100 || power > 5000) {
        throw new Error("模型返回的将领设定不完整或不符合性别、战力格式");
      }
      await this.applyLocalIntent({
        type: "grant-general",
        generalId: crypto.randomUUID(),
        discoveryId: request.idempotencyKey,
        name: name.slice(0, 24),
        gender,
        location: { x: effect.x, y: effect.y },
        setting,
        power,
        initial: Boolean(effect.initial),
        idempotencyKey: `general:${request.idempotencyKey}`
      }, effect.accountId);
    }
  }

  async completeDialogue(request, actorAccountId, intent) {
    const general = this.world.generals?.[intent.generalId];
    const player = this.world.players?.[actorAccountId];
    const parsed = await this.requestModelWithGeneralWorldBook(request, general);
    const reply = String(parsed.reply || "").trim().slice(0, 2000);
    if (!reply) throw new Error("将领互动未返回有效回答");
    const memory = await this.requestStructuredModel(
      buildGeneralMemoryUpdateRequest(this.world, general, player, { userText: intent.topic, reply, idempotencyKey: `memory:${intent.idempotencyKey}` }, this.now()),
      { attempts: 2, label: "将领记忆整理" }
    );
    const category = memory?.category === "deed" ? "deed" : memory?.category === "speech" ? "speech" : "";
    const summary = String(memory?.summary || "").trim();
    const emotion = String(memory?.emotion || "").trim();
    const compactMemory = String(memory?.compactMemory || "").trim();
    const intimacyDelta = Number(memory?.intimacyDelta);
    if (!category || !summary || summary.length > 120 || emotion.length > 40 || !compactMemory || compactMemory.length > 1000 || !Number.isInteger(intimacyDelta) || intimacyDelta < -5 || intimacyDelta > 5) throw new Error("将领记忆世界书返回格式不完整");
    await this.applyLocalIntent({
      type: "record-general-dialogue",
      generalId: intent.generalId,
      topic: summary,
      userText: intent.topic,
      reply,
      intimacyDelta,
      memoryUpdate: { category, summary, emotion, intimacyDelta, compactMemory },
      idempotencyKey: `dialogue:${intent.idempotencyKey}`
    }, actorAccountId);
    const command = parsed.command && typeof parsed.command === "object" ? parsed.command : null;
    let commandResult = null;
    if (command?.type === "surrender" && general?.status === "captured") {
      commandResult = await this.applyLocalIntent({ type: "surrender-general", generalId: general.id, idempotencyKey: `surrender:${intent.idempotencyKey}` }, actorAccountId);
    } else if (command?.type === "send-letter") {
      commandResult = await this.sendDirect(String(command.toAccountId || ""), "general-letter", { generalId: general?.id, text: String(command.text || "") }, { fromGeneralDialogue: true });
    }
    return { reply, memory: { category, summary, emotion, intimacyDelta, compactMemory }, intimacyDelta, command: command || null, commandResult };
  }

  async requestModelWithGeneralWorldBook(request, general) {
    if (!general) return this.requestStructuredModel(request, { attempts: 2, label: "将领互动" });
    // Per-player world books belong to the current platform conversation. If
    // the first request has not created one yet, the structured input still
    // carries the complete general context and establishes that conversation.
    const conversationId = String(this.modelConversationId || "").trim();
    if (!conversationId) return this.requestStructuredModel(request, { attempts: 2, label: "将领互动" });
    let payload;
    try {
      payload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(this.work.id)}&conversation_id=${encodeURIComponent(conversationId)}`, { timeout: 15000 });
    } catch {
      return this.requestStructuredModel(request, { attempts: 2, label: "将领互动" });
    }
    const config = payload?.data?.data ?? payload?.data ?? payload ?? {};
    const original = Array.isArray(config.world_book) ? config.world_book : [];
    const marker = `FYOW_GENERAL:${general.id}`;
    const extras = [];
    if (!original.some(entry => String(entry?.value || "").includes(marker))) extras.push(this.generalWorldBookEntry(general));
    if (this.localPreferences.playerContext && !original.some(entry => String(entry?.value || "").includes("FYOW_PLAYER_CONTEXT:"))) extras.push(this.playerWorldBookEntry());
    if (!extras.length) return this.requestStructuredModel(request, { attempts: 2, label: "将领互动" });
    let applied = false;
    try {
      await this.requestGo("/apps/config", { method: "POST", body: { app_id: this.work.id, conversation_id: conversationId, is_global: false, world_book: [...original, ...extras] }, timeout: 15000 });
      applied = true;
    } catch {
      return this.requestStructuredModel(request, { attempts: 2, label: "将领互动" });
    }
    try {
      return await this.requestStructuredModel(request, { attempts: 2, label: "将领互动" });
    } finally {
      if (applied) await this.requestGo("/apps/config", { method: "POST", body: { app_id: this.work.id, conversation_id: conversationId, is_global: false, world_book: original }, timeout: 15000 }).catch(() => {});
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

  playerWorldBookEntry() {
    const context = this.localPreferences.playerContext || {};
    const marker = `FYOW_PLAYER_CONTEXT:${this.localPreferences.characterProfileId || "bound"}`;
    return {
      group: "在线游戏世界/玩家角色",
      match_type: 2,
      key: `_or_${String(context.displayName || "玩家").slice(0, 80)}`,
      key_region: 2,
      value_type: 0,
      value: `${marker}\n角色摘要：${context.personaSummary || "暂无"}\n外貌：${context.appearanceSummary || "暂无"}\n说话方式：${context.speechStyle || "暂无"}\n关系倾向：${context.relationshipApproach || "暂无"}`.slice(0, 6000),
      value_configs: [], value_region: 1, sort: -1, depth: 0, probability: 100, enable: true
    };
  }

  async reconcileOwnGeneralWorldBooks() {
    if (!this.world || !this.work) return;
    const conversationId = String(this.modelConversationId || "").trim();
    if (!conversationId) return;
    const accountId = this.account().accountId;
    const player = this.world.players?.[accountId];
    if (!player) return;
    const desired = (player.carriedGeneralIds || []).map(id => this.world.generals?.[id]).filter(Boolean);
    const fingerprint = sha256(Buffer.from(canonicalJson({
      playerContext: this.localPreferences.playerContext,
      generals: desired.map(general => ({ id: general.id, name: general.name, setting: general.setting, memoryText: general.memoryText }))
    })))
    if (fingerprint === this.worldBookFingerprint) return;
    const payload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(this.work.id)}&conversation_id=${encodeURIComponent(conversationId)}`, { timeout: 15000 });
    const config = payload?.data?.data ?? payload?.data ?? payload ?? {};
    const worldBook = (Array.isArray(config.world_book) ? config.world_book : []).filter(entry => {
      const value = String(entry?.value || "");
      return !value.includes("FYOW_GENERAL:") && !value.includes("FYOW_PLAYER_CONTEXT:");
    });
    if (this.localPreferences.playerContext) worldBook.push(this.playerWorldBookEntry());
    worldBook.push(...desired.map(general => this.generalWorldBookEntry(general)));
    await this.requestGo("/apps/config", { method: "POST", body: { app_id: this.work.id, conversation_id: conversationId, is_global: false, world_book: worldBook }, timeout: 15000 });
    const verifiedPayload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(this.work.id)}&conversation_id=${encodeURIComponent(conversationId)}`, { timeout: 15000 });
    const verified = verifiedPayload?.data?.data ?? verifiedPayload?.data ?? verifiedPayload ?? {};
    const persisted = new Set((Array.isArray(verified.world_book) ? verified.world_book : []).map(entry => String(entry?.value || "").match(/FYOW_GENERAL:([^\s]+)/)?.[1]).filter(Boolean));
    const playerPersisted = !this.localPreferences.playerContext || (Array.isArray(verified.world_book) ? verified.world_book : []).some(entry => String(entry?.value || "").includes("FYOW_PLAYER_CONTEXT:"));
    if (!playerPersisted || persisted.size !== desired.length || desired.some(general => !persisted.has(String(general.id)))) throw new Error("玩家与将领世界书保存后校验失败");
    this.worldBookFingerprint = fingerprint;
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

  async sendDirect(toAccountId, type, payload, options = {}) {
    if (!this.control || !this.world) throw new Error("本赛季尚未初始化");
    const sender = this.account();
    if (this.world.bans?.[sender.accountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁，书信指令会被忽略");
    const recipient = String(toAccountId || "");
    if (!recipient || recipient === sender.accountId) throw new Error("请选择另一名在线世界玩家");
    const messageType = String(type || "");
    if (!options.fromGeneralDialogue) throw new Error("将领书信必须由互动结果触发");
    if (messageType !== "general-letter") throw new Error("书信只能由将领互动触发");
    const text = String(payload?.text || "").trim().slice(0, 500);
    if (!text) throw new Error("消息正文不能为空");
    const general = this.world.generals?.[String(payload?.generalId || "")];
    if (!general || general.holderAccountId !== sender.accountId) throw new Error("将领当前不归本机玩家保管");
    const player = this.world.players?.[sender.accountId];
    const interactable = general.status === "captured" || player?.carriedGeneralIds?.includes(general.id)
      || (general.status === "deployed" && general.location?.x === player?.position?.x && general.location?.y === player?.position?.y);
    if (!interactable) throw new Error("将领当前不在可交互位置");
    const formerLords = new Set((general.masterHistory || []).map(item => String(item.accountId || "")).filter(id => id && id !== sender.accountId));
    if (!formerLords.has(recipient)) throw new Error("将领只能写信给记录中存在过的主公");
    const normalizedPayload = { generalId: general.id, generalName: general.name, text };
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
      .filter(record => !this.world.bans?.[record.fromAccountId]?.banned)
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
    const description = String(exported.desc || exported.descr || exported.dsc || exported.intro || exported.description || this.work.description || "");
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
      oldWorkRenamed = String(oldVerified?.name ?? oldVerified?.nm ?? oldVerified?.ttl ?? oldVerified?.title ?? oldVerified?.app_name ?? oldVerified?.app?.name ?? "") === archivedName;
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

module.exports = { OnlineWorldService, workReference, normalizeWorkDetail, commentAccountId, commentTimestamp, recordPlatformOrder, comparePlatformOrder, parseJsonAnswer, HISTORY_PAGE_SIZE, MAX_HISTORY_PAGES };
