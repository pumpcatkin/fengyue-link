const crypto = require("node:crypto");
const fs = require("node:fs");
const { atomicWriteJsonSync, readJsonWithBackupSync } = require("./runtime-utils.cjs");
const { isTransientPlatformError, platformRequestError } = require("./platform-transport.cjs");
const {
  FYOW_SCHEMAS,
  FYOW_COMMENT_LIMIT,
  canonicalJson,
  sha256,
  encodeCommentRecord,
  decodeCommentChunk,
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
const {
  GRID_GAME_TITLE,
  builtInGridProgram,
  validateGameCard,
  createExportedGameCard,
  refreshGameCardProgram,
  summarizeGameCard
} = require("./online-world-card.cjs");
const {
  GRID_GAME_ID,
  GRID_SIZE,
  staticCell,
  createWorld,
  resetPlayerState,
  settleWorld,
  applyIntent,
  battleCasualties,
  recordBattleReport,
  marchQuote,
  scatterTreasures,
  buildGeneralGenerationRequest,
  buildGeneralLetterRequest,
  buildGeneralAppearanceRequest,
  buildPlayerProfileContextRequest,
  buildGeneralMemoryUpdateRequest,
  normalizedCharacterTags,
  generatedGeneralPower,
  ensurePowerProgress,
  generalExperienceRequirement,
  ensureGeneralProfile,
  cellOccupationCount,
  cellGarrisonCap,
  MAX_OCCUPATION_COUNT,
  publicMarketListingState,
  projectWorldState,
  publicGeneralState
} = require("./grid-world-game.cjs");

const HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGES = 10000;
const POLL_INTERVAL_MS = 5000;
const POLL_RETRY_MAX_MS = 60 * 1000;
const DIRECT_RATE_WINDOW_MS = 60 * 1000;
const DIRECT_SEND_LIMIT = 12;
const DIRECT_RECEIVE_LIMIT_PER_SENDER = 20;
const PUBLIC_LEDGER_COMPACTION_DELTAS = 32;
const COMMENT_POST_ATTEMPTS = 3;
const PENDING_EFFECT_RETRY_BASE_MS = 30 * 1000;
const PENDING_EFFECT_RETRY_MAX_MS = 15 * 60 * 1000;
const MAX_GENERAL_CORE_SETTING_LENGTH = 12000;
const DEFAULT_GENERATED_GENERAL_POWER = 150;
const WORLD_CHAT_LIMIT = 50;
const WORLD_CHAT_TEXT_LIMIT = 500;
const WORLD_CHAT_SEND_LIMIT = 12;
const WORLD_CHAT_SCAN_PAGES = MAX_HISTORY_PAGES;
const REPLY_PAGE_LIMIT = 100;
// Public battle records carry enough numbers to reproduce the casualty formula,
// but they must stay within the same finite ranges accepted by local intents.
// The bounds also keep a signed comment from becoming a numeric amplification
// vector for a remote reader.
const MAX_PUBLIC_BATTLE_SOLDIERS = 1_000_000;
const MAX_PUBLIC_BATTLE_POWER = 1_000_000_000;
const { MATERIAL_BY_ID } = require("./grid-talents.cjs");

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
  const descriptionDetail = firstObject(payload, item => matchesWork(item) && Boolean(item?.description || item?.desc));
  const detail = namedDetail || authorDetail || payload?.data?.app || payload?.app || payload?.data || payload;
  const authority = authorDetail || detail;
  const author = authority?.author || authority?.creator || authority?.owner || authority?.created_by || authority?.createdBy || {};
  return {
    id: String(authority?.id || authority?.app_id || authority?.appId || detail?.id || detail?.app_id || detail?.appId || fallbackId),
    name: String(detail?.name || detail?.title || "在线游戏世界"),
    description: String(descriptionDetail?.description || descriptionDetail?.desc || detail?.description || detail?.desc || ""),
    authorAccountId: String(authorId(authority)),
    authorName: String(authority?.created_by_account_name || authority?.author_account_name || authority?.creator_account_name || authority?.owner_account_name || author?.name || author?.username || "")
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

function commentPageRoots(comments) {
  if (!Array.isArray(comments)) return [];
  if (!Array.isArray(comments.rootIds)) return comments.filter(comment => !comment?._fyowRootId);
  const ids = new Set(comments.rootIds);
  return comments.filter(comment => ids.has(commentId(comment)));
}

function commentPageRootCount(comments) {
  return Number.isSafeInteger(comments?.rootCount) ? comments.rootCount : commentPageRoots(comments).length;
}

async function completeReadBatch(requests) {
  const results = await Promise.allSettled(requests);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map(result => result.value);
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
  const root = item?.root || sources.find(source => decodeCommentChunk(source?.content)?.part === 1) || sources[0];
  return {
    timestamp: commentTimestamp(root),
    commentId: commentId(root)
  };
}

function comparePlatformOrder(left, right) {
  const a = recordPlatformOrder(left);
  const b = recordPlatformOrder(right);
  return a.timestamp - b.timestamp || a.commentId.localeCompare(b.commentId);
}

function ledgerOrder(value) {
  return {
    timestamp: Math.max(0, Number.isFinite(Number(value?.timestamp)) ? Number(value.timestamp) : 0),
    commentId: String(value?.commentId || "")
  };
}

function snapshotCoverage(record) {
  const coverage = record?.ledgerCoverage;
  return coverage?.version === 1 && coverage.through && Number.isFinite(Number(coverage.through.timestamp))
    && Number(coverage.through.timestamp) >= 0 ? coverage : null;
}

function normalizeWorldChatText(value) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text) throw new Error("世界聊天内容不能为空");
  if (Array.from(text).length > WORLD_CHAT_TEXT_LIMIT) throw new Error(`世界聊天内容不能超过 ${WORLD_CHAT_TEXT_LIMIT} 字`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error("世界聊天内容包含不可见控制字符");
  if (/[<>]/u.test(text)) throw new Error("世界聊天只支持纯文本");
  return text;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function actionConnectionError(error) {
  const message = String(error?.message || error || "");
  if (!/Failed to fetch|fetch failed|NetworkError|网络连接|平台请求超时|后台账号页面载入超时/i.test(message)) return error;
  const wrapped = new Error("平台连接暂时中断，本次行动尚未提交；请检查网络或代理后重试", { cause: error });
  // Keep the structured request metadata when a platform/network error is
  // wrapped, so the game can offer the same explicit retry flow as model errors.
  for (const key of ["errorCode", "retryable", "userMessage", "modelUsage"]) {
    if (error?.[key] !== undefined) wrapped[key] = error[key];
  }
  return wrapped;
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

function playerContextFromProfile(value = {}) {
  const profile = normalizeCharacterProfile(value);
  return {
    displayName: profile.displayName,
    personaSummary: profile.basicInfo || profile.info,
    appearanceSummary: profile.appearance,
    speechStyle: "",
    relationshipApproach: ""
  };
}

function validPosition(value) {
  return value?.x != null && value?.y != null
    && Number.isInteger(Number(value.x)) && Number(value.x) >= 0 && Number(value.x) < GRID_SIZE
    && Number.isInteger(Number(value.y)) && Number(value.y) >= 0 && Number(value.y) < GRID_SIZE;
}

function validRetreatPath(value, position) {
  if (!validPosition(position) || !Array.isArray(value) || !value.length || value.length > GRID_SIZE * GRID_SIZE || !value.every(validPosition)) return false;
  if (Number(value[0].x) !== Number(position.x) || Number(value[0].y) !== Number(position.y)) return false;
  return value.every((point, index) => !index
    || Math.abs(Number(point.x) - Number(value[index - 1].x)) + Math.abs(Number(point.y) - Number(value[index - 1].y)) === 1);
}

function finiteStoredNumber(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function modelPointNumber(value) {
  const number = Number(typeof value === "string" ? value.replace(/,/g, "").trim() : value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function compareOrderValue(left, right) {
  return Number(left?.timestamp || 0) - Number(right?.timestamp || 0)
    || String(left?.commentId || "").localeCompare(String(right?.commentId || ""));
}

function publicCells(state, { includeOccupationCount = false } = {}) {
  return Object.fromEntries(Object.entries(state?.cells || {})
    .filter(([, cell]) => cell?.ownerAccountId || Number(cell?.soldiers || 0) || (cell?.generalIds || []).length || cellOccupationCount(cell) > 0)
    .map(([key, cell]) => [key, {
      ownerAccountId: cell.ownerAccountId ? String(cell.ownerAccountId) : null,
      soldiers: Math.max(0, Math.trunc(Number(cell.soldiers || 0))),
      generalIds: [...new Set((cell.generalIds || []).map(String))].slice(0, 2),
      ...(includeOccupationCount ? { occupationCount: cellOccupationCount(cell) } : {})
    }]));
}

function isPublicCellShape(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return false;
  const keys = Object.keys(cell).sort();
  const legacy = keys.length === 3 && keys[0] === "generalIds" && keys[1] === "ownerAccountId" && keys[2] === "soldiers";
  const current = keys.length === 4 && keys[0] === "generalIds" && keys[1] === "occupationCount"
    && keys[2] === "ownerAccountId" && keys[3] === "soldiers";
  if (!legacy && !current) return false;
  return legacy || (Number.isSafeInteger(cell.occupationCount)
    && cell.occupationCount >= 0 && cell.occupationCount <= MAX_OCCUPATION_COUNT);
}

function comparablePublicCell(cell) {
  if (!cell) return null;
  return {
    ownerAccountId: cell.ownerAccountId ? String(cell.ownerAccountId) : null,
    soldiers: Math.max(0, Math.trunc(Number(cell.soldiers || 0))),
    generalIds: [...new Set((cell.generalIds || []).map(String))].slice(0, 2),
    occupationCount: cellOccupationCount(cell)
  };
}

function samePublicCell(left, right) {
  return canonicalJson(comparablePublicCell(left)) === canonicalJson(comparablePublicCell(right));
}

function validOccupationTransition(currentCell, nextCell, { allowLegacy = true, baseCell = currentCell, requireBase = false } = {}) {
  const currentCount = cellOccupationCount(currentCell);
  const explicit = Object.hasOwn(nextCell || {}, "occupationCount");
  // Legacy clients can keep publishing after a program update. Missing counters
  // preserve the established count; they must not invalidate the ownership write.
  if (!explicit) return allowLegacy;
  const nextCount = Number(nextCell.occupationCount);
  if (!Number.isSafeInteger(nextCount) || nextCount < 0 || nextCount > MAX_OCCUPATION_COUNT) return false;
  const transitionBase = requireBase ? baseCell : currentCell;
  const baseCount = cellOccupationCount(transitionBase);
  const baseOwner = String(transitionBase?.ownerAccountId || "");
  const nextOwner = String(nextCell?.ownerAccountId || "");
  const ownerChanged = baseOwner !== nextOwner;
  const expected = ownerChanged && nextCell?.ownerAccountId
    ? Math.min(MAX_OCCUPATION_COUNT, baseCount + 1)
    : baseCount;
  if (nextCount !== expected) return false;
  if (!requireBase || samePublicCell(currentCell, transitionBase) || samePublicCell(currentCell, nextCell)) return true;
  // Two players may publish from the same observed owner before either sees the
  // other. Both describe one causal takeover, so the later platform record may
  // replace the earlier winner at the same increment instead of inventing an
  // extra occupation that never happened on either client.
  const currentOwner = String(currentCell?.ownerAccountId || "");
  return ownerChanged && Boolean(nextOwner) && currentCount === expected
    && currentOwner !== baseOwner && currentOwner !== nextOwner;
}

function validGeneralTransitionShape(id, transition) {
  if (!transition || typeof transition !== "object" || Array.isArray(transition)) return false;
  if (String(transition.generalId || "") !== String(id) || !String(transition.holderAccountId || "")) return false;
  if (!validPosition(transition.from)) return false;
  if (!["carried", "captured", "waiting", "removed"].includes(String(transition.targetStatus || ""))) return false;
  if (!["recalled", "captured", "removed"].includes(String(transition.reason || ""))) return false;
  if (transition.reason === "recalled") {
    return transition.targetStatus === "carried"
      && String(transition.nextHolderAccountId || "") === String(transition.holderAccountId || "");
  }
  if (transition.reason === "captured") {
    return transition.targetStatus === "captured"
      && Boolean(String(transition.nextHolderAccountId || ""))
      && String(transition.nextHolderAccountId || "") !== String(transition.holderAccountId || "");
  }
  return transition.targetStatus === "removed";
}

function safeBattleInteger(value, maximum = MAX_PUBLIC_BATTLE_SOLDIERS, minimum = 0) {
  // Reject coercible placeholders from a remote JSON record instead of
  // silently treating null, booleans, or blank strings as zero.
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function publicGenerals(state) {
  return Object.fromEntries(Object.entries(state?.generals || {})
    .filter(([, general]) => general?.status === "deployed")
    .map(([id, general]) => [id, publicGeneralState(general)]));
}

function changedPublicGenerals(beforeWorld, afterWorld) {
  const before = publicGenerals(beforeWorld);
  const after = publicGenerals(afterWorld);
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = Object.hasOwn(before, key) ? before[key] : null;
    const next = Object.hasOwn(after, key) ? after[key] : null;
    const comparable = value => {
      if (!value) return value;
      const copy = cloneJson(value);
      delete copy.experience;
      return copy;
    };
    if (canonicalJson(comparable(previous)) !== canonicalJson(comparable(next))) changes[key] = cloneJson(next);
  }
  return changes;
}

function changedPublicGeneralTransitions(beforeWorld, afterWorld) {
  const transitions = {};
  const before = publicGenerals(beforeWorld);
  for (const [id, previous] of Object.entries(before)) {
    const next = afterWorld?.generals?.[id];
    if (next?.status === "deployed") continue;
    transitions[id] = {
      generalId: id,
      holderAccountId: String(previous.holderAccountId || ""),
      from: { x: Number(previous.location?.x), y: Number(previous.location?.y) },
      targetStatus: next ? String(next.status || "waiting") : "removed",
      nextHolderAccountId: next ? String(next.holderAccountId || "") : "",
      reason: next?.status === "captured" ? "captured" : next?.status === "carried" ? "recalled" : "removed"
    };
  }
  return transitions;
}

function deployedGeneralProgressFor(state, accountId) {
  const owner = String(accountId || "");
  return Object.fromEntries(Object.entries(state?.generals || {})
    .filter(([, general]) => general?.status === "deployed" && String(general.holderAccountId || "") === owner)
    .map(([id, general]) => [id, {
      cultivationCount: Math.max(0, Math.trunc(Number(general.cultivationCount || 0))),
      experience: Math.max(0, Number(general.experience || 0)),
      experienceUpdatedAt: Math.max(0, Number(general.experienceUpdatedAt || 0))
    }]));
}

function publicMarketListings(state) {
  return Object.fromEntries(Object.entries(state?.marketListings || {})
    .map(([id, listing]) => [id, publicMarketListingState(state, listing)]));
}

function cacheWorldForPersistence(state) {
  // A local archive is not disposable merely because a public projection also
  // exists. Public history can be incomplete during reconnect, so persist the
  // complete state and use verified transition records for real removals.
  return cloneJson(state);
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

function publicBattleChanges(beforeWorld, afterWorld, effects = [], actorAccountId = "") {
  const battles = {};
  for (const effect of effects || []) {
    if (effect?.type !== "battle-lost" || String(effect.accountId || "") !== String(actorAccountId || "")) continue;
    const x = Number(effect.at?.x);
    const y = Number(effect.at?.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    const key = `${x},${y}`;
    const before = beforeWorld?.cells?.[key];
    const after = afterWorld?.cells?.[key];
    // Only enemy-held cells whose garrison was reduced need this side-channel.
    // Conquests already become the actor's own public cell and pass the normal
    // ownership validation below.
    if (!before?.ownerAccountId || String(before.ownerAccountId) === String(actorAccountId || "") || !after) continue;
    if (String(after.ownerAccountId || "") !== String(before.ownerAccountId) || Number(after.soldiers) >= Number(before.soldiers)) continue;
    const battleId = String(effect.jobId || `${key}:${effect.createdAt || "battle"}`).slice(0, 100);
    battles[battleId] = {
      battleId,
      attackerAccountId: String(actorAccountId),
      x, y,
      targetOwnerAccountId: String(before.ownerAccountId),
      beforeSoldiers: Math.max(0, Math.trunc(Number(before.soldiers || 0))),
      afterSoldiers: Math.max(0, Math.trunc(Number(after.soldiers || 0))),
      attackerSoldiers: Math.max(0, Math.trunc(Number(effect.attackerSoldiers || 0))),
      defenderSoldiers: Math.max(0, Math.trunc(Number(effect.defenderSoldiers || 0))),
      attackerPower: Math.max(1, Math.trunc(Number(effect.attackerPower || 0))),
      defenderPower: Math.max(1, Math.trunc(Number(effect.defenderPower || 0))),
      attackerLosses: Math.max(0, Math.trunc(Number(effect.attackerLosses || 0))),
      defenderLosses: Math.max(0, Math.trunc(Number(effect.defenderLosses || 0))),
      attackerSurvivors: Math.max(0, Math.trunc(Number(effect.survivors || 0))),
      defenderSurvivors: Math.max(0, Math.trunc(Number(effect.defenderSurvivors || 0))),
      outcome: "attacker-lost"
    };
  }
  return battles;
}

function createPublicMapChanges(beforeWorld, afterWorld, effects = [], actorAccountId = "") {
  const beforeCells = publicCells(beforeWorld);
  const afterCells = publicCells(afterWorld);
  const countedBeforeCells = publicCells(beforeWorld, { includeOccupationCount: true });
  const cells = changedEntries(beforeCells, afterCells);
  const claims = changedEntries(beforeWorld?.claimedTreasures || {}, afterWorld?.claimedTreasures || {});
  for (const [id, claim] of Object.entries(claims)) {
    if (claim) claim.materialId = String(beforeWorld?.treasureSpawns?.[id]?.materialId || claim.materialId || "");
  }
  return {
    cells,
    cellBases: Object.fromEntries(Object.keys(cells).map(key => [key, {
      cell: Object.hasOwn(countedBeforeCells, key) ? cloneJson(countedBeforeCells[key]) : null,
      nextOccupationCount: cellOccupationCount(afterWorld?.cells?.[key])
    }])),
    generals: changedPublicGenerals(beforeWorld, afterWorld),
    generalTransitions: changedPublicGeneralTransitions(beforeWorld, afterWorld),
    marketListings: changedEntries(publicMarketListings(beforeWorld), publicMarketListings(afterWorld)),
    marketSales: changedEntries(beforeWorld?.marketSales || {}, afterWorld?.marketSales || {}),
    claimedTreasures: claims,
    battles: publicBattleChanges(beforeWorld, afterWorld, effects, actorAccountId),
    conquests: Object.fromEntries((effects || [])
      .filter(effect => effect.type === "battle-won" && effect.accountId === actorAccountId && effect.previousOwner && effect.previousOwner !== actorAccountId)
      .map(effect => {
        const report = afterWorld.privatePlayers?.[actorAccountId]?.battleReports?.find(item => item.jobId === effect.jobId);
        return [effect.jobId, {
          battleId: effect.jobId, attackerAccountId: actorAccountId,
          attackerDisplayName: String(afterWorld.players?.[actorAccountId]?.displayName || actorAccountId).slice(0, 40),
          attackerAccountName: String(afterWorld.players?.[actorAccountId]?.accountName || actorAccountId).slice(0, 80),
          targetOwnerAccountId: String(effect.previousOwner),
          targetPlayerEpoch: Number(beforeWorld.playerEpochs?.[effect.previousOwner] || 0),
          x: effect.at.x, y: effect.at.y, createdAt: Math.trunc(Number(report?.createdAt || 0)),
          attackerPower: effect.attackerPower, defenderPower: effect.defenderPower,
          attackerSoldiers: effect.attackerSoldiers, defenderSoldiers: effect.defenderSoldiers,
          attackerLosses: effect.attackerLosses, defenderLosses: effect.defenderLosses,
          attackerSurvivors: effect.attackerSurvivors, defenderSurvivors: effect.defenderSurvivors,
          capturedOwnGenerals: (effect.capturedGeneralIds || []).map(id => ({
            id: String(id), name: String(beforeWorld.generals?.[id]?.name || "无名将领").slice(0, 24)
          }))
        }];
      }))
  };
}

function attachCellBaseOrders(changes, cellOrders, baselineOrder) {
  for (const [key, base] of Object.entries(changes?.cellBases || {})) {
    if (!base || typeof base !== "object" || Array.isArray(base)) continue;
    base.order = ledgerOrder(cellOrders?.[key] || baselineOrder);
  }
  return changes;
}

function occupationEnvelope(changes, key) {
  const wireCell = changes?.cells?.[key];
  const raw = changes?.cellBases?.[key];
  const modern = Boolean(raw && typeof raw === "object" && !Array.isArray(raw)
    && Object.hasOwn(raw, "cell") && Object.hasOwn(raw, "nextOccupationCount") && Object.hasOwn(raw, "order"));
  return {
    modern,
    baseCell: modern ? raw.cell : null,
    baseOrder: modern ? ledgerOrder(raw.order) : { timestamp: 0, commentId: "" },
    nextCell: wireCell == null ? null : {
      ...wireCell,
      ...(modern ? { occupationCount: raw.nextOccupationCount } : {})
    }
  };
}

function effectivePublicCell(changes, key, currentCell) {
  const envelope = occupationEnvelope(changes, key);
  const next = envelope.nextCell;
  if (next == null) return cellOccupationCount(currentCell) > 0
    ? { ownerAccountId: null, soldiers: 0, generalIds: [], occupationCount: cellOccupationCount(currentCell) }
    : null;
  if (envelope.modern || Object.hasOwn(next, "occupationCount")) return next;
  return { ...next, occupationCount: cellOccupationCount(currentCell) };
}

function mergeGeneralHistories(local, remote) {
  const result = { ...cloneJson(local), ...cloneJson(remote) };
  result.interactionHistory = [...new Map([...(local?.interactionHistory || []), ...(remote?.interactionHistory || [])]
    .map(entry => [canonicalJson(entry), cloneJson(entry)])).values()];
  return result;
}

function occupationBaseDescriptor(envelope) {
  return {
    order: ledgerOrder(envelope?.baseOrder),
    hash: sha256(Buffer.from(canonicalJson(comparablePublicCell(envelope?.baseCell))))
  };
}

function hasPublicMapChanges(changes) {
  return Boolean(Object.keys(changes?.cells || {}).length || Object.keys(changes?.generals || {}).length
    || Object.keys(changes?.marketListings || {}).length || Object.keys(changes?.marketSales || {}).length
    || Object.keys(changes?.claimedTreasures || {}).length || Object.keys(changes?.battles || {}).length
    || Object.keys(changes?.conquests || {}).length);
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

const MODEL_PLACEHOLDER_PATTERN = /未提供|暂无|不详|未知|没有(?:提供|说明|填写)|未说明|待补充|占位/i;
const ACCOUNT_IDENTIFIER_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function playerContextQualityIssue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "玩家角色设定不是 JSON 对象";
  const fields = {
    personaSummary: String(value.personaSummary || "").trim(),
    appearanceSummary: String(value.appearanceSummary || "").trim(),
    speechStyle: String(value.speechStyle || "").trim(),
    relationshipApproach: String(value.relationshipApproach || "").trim()
  };
  if (fields.personaSummary.length < 120 || fields.personaSummary.length > 2000) return "玩家人物摘要需要完整补全到 120～2000 字";
  if (fields.appearanceSummary.length < 50 || fields.appearanceSummary.length > 1000) return "玩家外貌摘要需要完整补全到 50～1000 字";
  if (fields.speechStyle.length < 20 || fields.speechStyle.length > 500) return "玩家说话方式需要完整补全到 20～500 字";
  if (fields.relationshipApproach.length < 30 || fields.relationshipApproach.length > 800) return "玩家关系倾向需要完整补全到 30～800 字";
  if (Object.values(fields).some(text => MODEL_PLACEHOLDER_PATTERN.test(text))) return "玩家角色设定仍包含未补全的占位措辞";
  return null;
}

function generalGenerationQualityIssue(value, effect) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "将领设定不是 JSON 对象";
  return null;
}

function normalizeGeneratedGeneral(value, effect = {}, edits = null) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const legacyPersona = String(raw.personaSummary || "").trim();
  const inferredName = legacyPersona.match(/名为[“"「『]?([^”"」』，。；\s]{1,12})/)?.[1] || "";
  const source = {
    ...raw,
    name: raw.name || inferredName,
    appearanceSetting: raw.appearanceSetting || raw.appearanceSummary,
    coreSetting: raw.coreSetting || raw.setting || [legacyPersona, raw.speechStyle, raw.relationshipApproach].filter(item => item != null && String(item).trim()).map(item => String(item).trim()).join("\n")
  };
  const edited = edits && typeof edits === "object" && !Array.isArray(edits) ? edits : {};
  const gender = effect.gender === "male" ? "male" : "female";
  const fallbackMeasurements = gender === "female"
    ? { chestCm: 86, waistCm: 60, hipCm: 88 }
    : { chestCm: 98, waistCm: 78, hipCm: 96 };
  const bounded = (candidate, fallback, minimum, maximum, integer = false) => {
    const number = Number(candidate);
    const normalized = Number.isFinite(number) ? number : fallback;
    const limited = Math.max(minimum, Math.min(maximum, normalized));
    return integer ? Math.round(limited) : Math.round(limited * 10) / 10;
  };
  const text = (field, fallback, maximum) => {
    const candidate = Object.hasOwn(edited, field) ? edited[field] : source[field];
    return String(candidate || fallback).trim().slice(0, maximum);
  };
  const measurements = edited.measurements && typeof edited.measurements === "object"
    ? edited.measurements
    : (source.measurements && typeof source.measurements === "object" ? source.measurements : {});
  const wish = String(effect.initialWish || "").trim();
  return {
    name: text("name", gender === "female" ? "无名女将" : "无名良将", 24),
    gender,
    heightCm: bounded(Object.hasOwn(edited, "heightCm") ? edited.heightCm : source.heightCm, gender === "female" ? 166 : 178, 120, 230, true),
    weightKg: bounded(Object.hasOwn(edited, "weightKg") ? edited.weightKg : source.weightKg, gender === "female" ? 55 : 72, 30, 250),
    measurements: {
      chestCm: bounded(measurements.chestCm, fallbackMeasurements.chestCm, 30, 200),
      waistCm: bounded(measurements.waistCm, fallbackMeasurements.waistCm, 30, 200),
      hipCm: bounded(measurements.hipCm, fallbackMeasurements.hipCm, 30, 200)
    },
    appearanceSetting: text("appearanceSetting", gender === "female" ? "她衣着利落，神态沉着，带着常年行走乱世养成的警觉气质。" : "他衣着利落，神态沉着，带着常年行走乱世养成的警觉气质。", 350),
    coreSetting: text("coreSetting", wish || "此人出身乱世，具备成为良将的才能与抱负，愿追随拥有慧眼的主公开疆扩土。", MAX_GENERAL_CORE_SETTING_LENGTH),
    cultivationCount: 0,
    experience: 0,
    experienceRequired: generalExperienceRequirement(0),
    power: effect.generatedPower ?? (effect.generatedSeed
      ? generatedGeneralPower(effect.generatedSeed, effect.accountId, effect.sourceId || effect.discoveryId || "general")
      : DEFAULT_GENERATED_GENERAL_POWER)
  };
}

function dialogueQualityIssue(value, { captive = false, allowedRecipientKeys = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "将领互动结果不是 JSON 对象";
  const reply = String(value.reply || "").trim();
  if (!reply || reply.length > 2000) return "将领回答必须为 1～2000 字";
  if (ACCOUNT_IDENTIFIER_PATTERN.test(reply)) return "将领回答包含内部账号编号";
  if (value.command == null) return null;
  if (typeof value.command !== "object" || Array.isArray(value.command)) return "将领互动指令格式无效";
  const type = String(value.command.type || "");
  if (type === "surrender") return captive ? null : "普通将领不能返回降服指令";
  if (type === "appearance-change") {
    const note = String(value.command.note || "").trim();
    if (!note || note.length > 1000) return "外观变更说明必须为 1～1000 字";
    return ACCOUNT_IDENTIFIER_PATTERN.test(note) ? "外观变更说明包含内部账号编号" : null;
  }
  if (type !== "send-letter") return "将领互动返回了未知指令";
  const recipientKey = String(value.command.recipientKey || "");
  if (!recipientKey || !allowedRecipientKeys.includes(recipientKey)) return "将领书信目标不在历任主公名单中";
  const purpose = String(value.command.purpose || "").trim();
  const guidance = String(value.command.guidance || "").trim();
  const legacyText = String(value.command.text || "").trim();
  if (!purpose && !legacyText) return "将领书信必须说明写信目的";
  if (purpose.length > 300 || guidance.length > 800 || legacyText.length > 500) return "将领书信目标说明过长";
  if (ACCOUNT_IDENTIFIER_PATTERN.test(`${purpose}\n${guidance}\n${legacyText}`)) return "将领书信说明包含内部账号编号";
  return null;
}

function combinedDialogueQualityIssue(value, { captive = false, allowedRecipientKeys = [] } = {}) {
  const dialogueIssue = dialogueQualityIssue(value, { captive, allowedRecipientKeys });
  if (dialogueIssue) return dialogueIssue;
  const narration = String(value.narration || "").trim();
  if (narration.length > 600) return "将领旁白不得超过 600 字";
  if (narration && ACCOUNT_IDENTIFIER_PATTERN.test(narration)) return "将领旁白包含内部账号编号";
  return generalMemoryQualityIssue(value.memoryUpdate);
}

function letterQualityIssue(value, { allowedRecipientKeys = [], requiredRecipientKey = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "书信结果不是 JSON 对象";
  const recipientKey = String(value.recipientKey || "").trim();
  const text = String(value.text || "").trim();
  if (!recipientKey || !allowedRecipientKeys.includes(recipientKey)) return "书信收件人不在允许名单中";
  if (requiredRecipientKey && recipientKey !== requiredRecipientKey) return "书信收件人未按确认目标生成";
  if (!text || text.length > 1000) return "书信正文必须为 1～1000 字";
  if (ACCOUNT_IDENTIFIER_PATTERN.test(`${recipientKey}\n${text}`)) return "书信包含内部账号编号";
  return null;
}

function appearanceQualityIssue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "外观编辑结果不是 JSON 对象";
  const appearanceSetting = String(value.appearanceSetting || "").trim();
  if (!appearanceSetting || appearanceSetting.length > 350) return "外观设定必须为 1～350 字";
  return ACCOUNT_IDENTIFIER_PATTERN.test(appearanceSetting) ? "外观设定包含内部账号编号" : null;
}

function compactDialogueReply(value) {
  const characters = Array.from(String(value || "").trim());
  if (characters.length <= 180) return characters.join("");
  const head = characters.slice(0, 180);
  const sentenceEnd = head.findLastIndex(character => "。！？!?；".includes(character));
  if (sentenceEnd >= 70) return head.slice(0, sentenceEnd + 1).join("").trim();
  return `${head.slice(0, 179).join("").trimEnd()}…`;
}

function generalMemoryQualityIssue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "将领记忆结果不是 JSON 对象";
  const category = String(value.category || "");
  const summary = String(value.summary || "").trim();
  const emotion = String(value.emotion || "").trim();
  const compactMemory = String(value.compactMemory || "").trim();
  const intimacyDelta = Number(value.intimacyDelta);
  if (!["speech", "deed"].includes(category)) return "将领记忆分类必须为 speech 或 deed";
  if (!summary || summary.length > 120) return "将领记忆摘要必须为 1～120 字";
  if (!emotion || emotion.length > 40) return "将领记忆情绪必须为 1～40 字";
  if (!Number.isInteger(intimacyDelta) || intimacyDelta < -5 || intimacyDelta > 5) return "将领亲密度变化必须为 -5～5 的整数";
  if (!compactMemory || compactMemory.length > 1000 || !compactMemory.includes("言谈：") || !compactMemory.includes("经历：")) return "将领长期记忆必须同时包含言谈和经历且不超过 1000 字";
  if (ACCOUNT_IDENTIFIER_PATTERN.test(`${summary}\n${emotion}\n${compactMemory}`)) return "将领记忆包含内部账号编号";
  return null;
}

function exportedConfig(payload) {
  return firstObject(payload, item => ["world_book", "wbook", "lore_bk", "world_bk", "wb"].some(key => Object.hasOwn(item, key))
    && ["prpt", "ppt", "pre_pt", "prompt_pre", "pre_prompt"].some(key => Object.hasOwn(item, key)))
    || payload?.data || payload;
}

function modelConfigSavePayload(exported, workId, name, description, model) {
  const source = JSON.parse(JSON.stringify(exported || {}));
  const firstString = (...values) => values.find(value => typeof value === "string") || "";
  const firstNumber = (fallback, ...values) => {
    const value = values.map(Number).find(Number.isFinite);
    return value == null ? fallback : value;
  };
  const summary = String(source.summary ?? source.smry ?? source.abs_txt ?? source.sum_info ?? source.abstract ?? source.app?.summary ?? "在线游戏世界");
  const language = [source.lang, source.locale, source.lc, source.lng, source.language, source.app?.language]
    .map(value => typeof value === "string" ? value.trim() : "")
    .find(Boolean) || "zh-Hans";
  const prePrompt = String(source.pre_prompt ?? source.prpt ?? source.ppt ?? source.pre_pt ?? source.prompt_pre ?? "");
  const preText = String(source.pre_text ?? source.pretxt ?? source.ptx ?? source.pre_tx ?? source.prefix_txt ?? "");
  const postText = String(source.post_text ?? source.posttxt ?? source.potx ?? source.post_tx ?? source.suffix_txt ?? "");
  const worldBook = cloneJson(source.world_book || source.wbook || source.lore_bk || source.world_bk || source.wb || []);
  return {
    pre_prompt: prePrompt,
    pre_prompt_sort: firstNumber(0, source.pre_prompt_sort),
    pre_text: preText,
    pre_text_sort: firstNumber(0, source.pre_text_sort),
    post_text: postText,
    post_text_sort: firstNumber(0, source.post_text_sort),
    bg_image: firstString(source.bg_image, source.bgimg),
    bg_mobile: firstString(source.bg_mobile, source.bgmob),
    bg_music: firstString(source.bg_music),
    bgm: cloneJson(source.bgm || { tracks: [], autoplay: true }),
    auto_play_bg_music: source.auto_play_bg_music !== false,
    builtInCss: firstString(source.builtInCss, source.built_in_css, source.bicss),
    default_sent_message_count: firstNumber(6, source.default_sent_message_count, source.default_msg_count),
    prompt_type: firstString(source.prompt_type) || "simple",
    chat_prompt_config: cloneJson(source.chat_prompt_config || {}),
    completion_prompt_config: cloneJson(source.completion_prompt_config || {}),
    user_input_form: cloneJson(source.user_input_form || []),
    dataset_query_variable: firstString(source.dataset_query_variable),
    opening_statement: firstString(source.opening_statement, source.opening, source.ost) || "选择一段开场白",
    suggested_questions: cloneJson(source.suggested_questions || source.sq || []),
    more_like_this: cloneJson(source.more_like_this || { enabled: false }),
    suggested_questions_after_answer: cloneJson(source.suggested_questions_after_answer || { enabled: true }),
    speech_to_text: cloneJson(source.speech_to_text || { enabled: false }),
    text_to_speech: cloneJson(source.text_to_speech || { enabled: false, voice: "", language: "" }),
    retriever_resource: cloneJson(source.retriever_resource || { enabled: false }),
    sensitive_word_avoidance: cloneJson(source.sensitive_word_avoidance || { enabled: false, type: "", configs: [] }),
    agent_mode: cloneJson(source.agent_mode || { enabled: false, max_iteration: 5, strategy: "react", tools: [] }),
    model: cloneJson(model),
    dataset_configs: cloneJson(source.dataset_configs || { retrieval_model: "single", datasets: { datasets: [] } }),
    file_upload: cloneJson(source.file_upload || { image: { enabled: false, number_limits: 3, detail: "high", transfer_methods: ["remote_url", "local_file"] } }),
    world_book: worldBook,
    cg_book: cloneJson(source.cg_book || []),
    regex_replaces: cloneJson(source.regex_replaces || source.rgx_rep || []),
    ai_variable_json: firstString(source.ai_variable_json, source.ai_v_json),
    ai_variable_template: firstString(source.ai_variable_template, source.ai_v_template),
    ai_variable_prompt: firstString(source.ai_variable_prompt, source.ai_v_prompt),
    banned_words: cloneJson(source.banned_words || source.banned_wd || source.block_wd || []),
    auto_save: Boolean(source.auto_save),
    shortcut_commands: cloneJson(source.shortcut_commands || source.sc_cmds || []),
    preset_type: firstNumber(1, source.preset_type, source.preset_tp),
    preset_chats: cloneJson(source.preset_chats || source.pst_chats || []),
    recommended_mod_ids: cloneJson(source.recommended_mod_ids || []),
    extend: cloneJson(source.extend || { ai_variable_enabled: false }),
    app: {
      name: String(name),
      description: String(description),
      summary,
      language,
      gender: firstNumber(1, source.gender, source.ref_id2, source.app?.gender),
      cover: firstString(source.cover, source.cover_url, source.cvr_url, source.app?.cover),
      cover_tiny: firstString(source.cover_tiny, source.cvr_tiny, source.cover_sm, source.app?.cover_tiny),
      is_anonymous: Boolean(source.is_anonymous ?? source.is_anon ?? source.ianon ?? source.anon ?? source.app?.is_anonymous ?? false),
      update_content: "",
      mod_permission: firstNumber(4, source.mod_permission, source.mod_perm, source.mod_pm, source.mperm, source.app?.mod_permission),
      visible_platform: firstNumber(0, source.visible_platform, source.app?.visible_platform),
      disable_css_mod: Boolean(source.disable_css_mod ?? source.disable_cssmod ?? source.dcm ?? source.no_css_mod ?? source.app?.disable_css_mod ?? false),
      is_available_not_public: Boolean(source.is_available_not_public ?? source.avail_not_pub ?? source.is_avail_np ?? source.avail_np ?? source.ianp ?? source.app?.is_available_not_public ?? true),
      schedule_publish_or_not: false
    }
  };
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
  for (const cell of Object.values(value.cells)) {
    if (!cell || typeof cell !== "object" || !Object.hasOwn(cell, "occupationCount")) continue;
    if (!Number.isSafeInteger(cell.occupationCount) || cell.occupationCount < 0 || cell.occupationCount > MAX_OCCUPATION_COUNT) {
      delete cell.occupationCount;
    }
  }
  value.players ||= {};
  value.bans ||= {};
  value.playerEpochs ||= {};
  value.treasureSpawns ||= {};
  value.claimedTreasures ||= {};
  value.treasureEpoch = Math.max(0, Math.trunc(Number(value.treasureEpoch || 0)));
  value.privatePlayers ||= {};
  value.generals ||= {};
  value.marketListings ||= {};
  value.marketSales ||= {};
  value.conquests ||= {};
  value.authorityPlayerActions ||= {};
  value.jobs ||= {};
  value.processedIntents ||= [];
  for (const player of Object.values(value.players)) ensurePowerProgress(player, 300);
  for (const privatePlayer of Object.values(value.privatePlayers)) {
    if (!Array.isArray(privatePlayer.pendingGeneralDiscoveries)) privatePlayer.pendingGeneralDiscoveries = [];
  }
  for (const general of Object.values(value.generals)) ensureGeneralProfile(general);
  return value;
}

function validSnapshotOccupationCounts(state) {
  if (!state?.cells || typeof state.cells !== "object" || Array.isArray(state.cells)) return false;
  return Object.values(state.cells).every(cell => !cell || typeof cell !== "object" || !Object.hasOwn(cell, "occupationCount")
    || (Number.isSafeInteger(cell.occupationCount) && cell.occupationCount >= 0 && cell.occupationCount <= MAX_OCCUPATION_COUNT));
}

function bindWorldAuthority(world, control) {
  if (!world || !control) return world;
  const expected = String(control.authorityAccountId || "").trim();
  if (!expected) return world;
  const current = String(world.authorityAccountId || "").trim();
  if (current && current !== expected) throw new Error("公共地图权威绑定不一致");
  world.authorityAccountId = expected;
  return world;
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
    this.runModelTask = options.runModelTask;
    this.onClose = options.onClose;
    this.getAccount = options.getAccount;
    this.getIdentity = options.getIdentity;
    this.getOrigin = options.getOrigin;
    this.onChange = options.onChange || (() => {});
    this.onDiagnostic = options.onDiagnostic || (() => {});
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
    this.syncInFlight = null;
    this.commentReadSession = null;
    this.loadProgress = null;
    this.error = null;
    this.lastSyncAt = null;
    this.knownCommentIds = new Set();
    this.historyTailPage = 1;
    this.historyPageOrder = "unknown";
    this.commentRootPages = new Map();
    this.history = { pagesRead: 0, commentsRead: 0, stoppedBy: null, incomplete: 0, invalid: 0, tailPage: 1, pageOrder: "unknown" };
    this.pendingMigration = null;
    this.migrationProof = null;
    this.migrationDraft = null;
    this.directInbox = [];
    this.directHistory = [];
    this.seenDirectMessageIds = new Set();
    this.directSendTimes = [];
    this.directReceiveTimes = new Map();
    this.worldChat = [];
    this.worldChatSendTimes = [];
    this.worldChatCursor = null;
    this.localEvents = [];
    this.localPreferences = { orientation: "any", characterProfileId: "", characterTags: [], initialGeneralWish: "", characterProfile: null, playerContext: null };
    this.appliedMapDeltaIds = new Set();
    this.appliedAuthorityIds = new Set();
    this.publicDeltaCountSinceSnapshot = 0;
    this.publicMapOrder = { timestamp: 0, commentId: "" };
    this.publicMapBaselineOrder = { timestamp: 0, commentId: "" };
    this.publicHistoryOrder = { timestamp: 0, commentId: "" };
    this.publicCellOrders = {};
    this.publicCellWriteBases = {};
    this.publicGeneralOrders = {};
    this.publicGeneralRecalls = {};
    this.localGeneralArchiveOrders = {};
    this.publicMarketOrders = {};
    this.publicMarketSaleOrders = {};
    this.marketSettledSales = new Set();
    this.publicParticipantOrders = {};
    this.publicAuthorityOrders = {};
    this.publicTreasureSources = {};
    this.modelConversationIds = new Set();
    this.modelRequestQueue = Promise.resolve();
    this.modelUsageEvents = [];
    this.modelUsageSequence = 0;
    this.joinInFlight = null;
    this.pendingJoinPreview = null;
    this.intentInFlight = null;
    this.intentInFlightKey = "";
    this.migrationActive = false;
    this.migrationInFlight = null;
    this.pendingModelEffects = [];
    this.pollTimer = null;
    this.pollFailureCount = 0;
    this.syncPaused = false;
    this.mapFactsCache = null;
    this.experienceSessionStartedAt = null;
    this.localDeployedGeneralProgress = {};
    this.pendingIntentTransaction = null;
    this.lastPublishedMapOrder = null;
  }

  account() {
    const account = this.getAccount?.() || {};
    return {
      accountId: String(account.accountId || account.id || ""),
      username: String(account.username || ""),
      points: account.points == null ? null : String(account.points)
    };
  }

  isAuthority() {
    return Boolean(this.control && this.account().accountId && this.account().accountId === this.control.authorityAccountId);
  }

  directSession(control = this.control, work = this.work) {
    if (!control || !work?.id) return null;
    const seasonId = String(control.seasonId || "");
    const controlId = String(control.id || "");
    if (!seasonId) return null;
    return {
      gameId: GRID_GAME_ID,
      workId: String(work.id),
      seasonId,
      controlId,
      startedAt: Math.max(0, Number(control.startedAt || 0))
    };
  }

  sameDirectSession(left, right) {
    return Boolean(left && right
      && String(left.gameId || GRID_GAME_ID) === String(right.gameId || GRID_GAME_ID)
      && String(left.workId || "") === String(right.workId || "")
      && String(left.seasonId || "") === String(right.seasonId || ""));
  }

  directItemMatchesSession(item, session = this.directSession()) {
    if (!item || !session) return false;
    if (item.gameId && String(item.gameId) !== session.gameId) return false;
    if (item.workId && String(item.workId) !== session.workId) return false;
    if (item.seasonId && String(item.seasonId) !== session.seasonId) return false;
    if (item.workId && item.seasonId) return true;
    const createdAt = Number(item.createdAt || 0);
    return createdAt > 0 && createdAt >= Math.max(0, session.startedAt - 5 * 60 * 1000);
  }

  clearDirectSession() {
    this.directInbox = [];
    this.directHistory = [];
    this.seenDirectMessageIds.clear();
  }

  restoreDirectCache(cached) {
    const session = this.directSession();
    if (!session) {
      this.clearDirectSession();
      return;
    }
    const inbox = (Array.isArray(cached?.directInbox) ? cached.directInbox : [])
      .filter(item => this.directItemMatchesSession(item, session)).slice(-100);
    const historySource = Array.isArray(cached?.directHistory) ? cached.directHistory : inbox;
    const history = historySource.filter(item => this.directItemMatchesSession(item, session)).slice(-200);
    this.directInbox = inbox;
    this.directHistory = history;
    const visibleIds = new Set([...inbox, ...history].map(item => String(item?.messageId || "")).filter(Boolean));
    const savedIds = this.sameDirectSession(cached?.directSession, session) && Array.isArray(cached?.seenDirectMessageIds)
      ? cached.seenDirectMessageIds.map(String)
      : [];
    this.seenDirectMessageIds = new Set([...savedIds, ...visibleIds].slice(-500));
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
      loadProgress: this.loadProgress ? { ...this.loadProgress } : null,
      migration: this.pendingMigration ? { ...this.pendingMigration } : null,
      directInboxCount: this.directInbox.length,
      directMessageCount: this.directHistory.length,
      localEventCount: this.localEvents.length,
      pendingModelEffectCount: this.pendingModelEffects.length,
      publicDeltaCountSinceSnapshot: this.publicDeltaCountSinceSnapshot,
      clock: { source: this.lastClockCalibrationAt ? "platform-date" : "host", calibratedAt: this.lastClockCalibrationAt, offsetMs: Math.round(this.now() - this.rawNow()) },
      program: { source: this.program.source, digest: this.program.digest, title: this.program.manifest?.title || "猎艳疆土", apiVersion: this.program.manifest?.apiVersion || 1 }
    };
  }

  state() {
    const account = this.account();
    const projection = this.world ? projectWorldState(this.world, account.accountId, this.now()) : null;
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
      directHistory: this.directHistory.slice(-200),
      worldChat: this.currentWorldChat().map(({ messageId, displayName, text, createdAt, accountId }) => ({ messageId, displayName, text, createdAt, accountId })),
      modelUsageEvents: cloneJson(this.modelUsageEvents.slice(-30)),
      programHtml: this.program?.html || null,
      serverNow: this.now()
    };
  }

  notify() {
    try { this.onChange(this.state()); } catch {}
  }

  updateLoadProgress(patch = {}) {
    if (!this.loadProgress?.active) return;
    this.loadProgress = { ...this.loadProgress, ...patch };
    this.notify();
  }

  trackReadComments(comments) {
    const session = this.commentReadSession;
    if (!session || !this.loadProgress?.active) return;
    for (const comment of comments) {
      const id = commentId(comment);
      if (id) session.comments.set(id, comment);
    }
    const roots = commentPageRoots([...session.comments.values()]).length;
    const unreadRoots = Math.max(0, (session.totalRoots || roots) - roots);
    this.updateLoadProgress({
      phase: this.loadProgress.phase === "validating" ? "validating" : "reading", readComments: session.comments.size,
      totalComments: session.totalRoots == null ? null : session.comments.size + unreadRoots
    });
  }

  diagnostic(detail) {
    try { this.onDiagnostic({ ...detail, workId: this.work?.id || null }); } catch {}
  }

  recordModelUsage({ request, label, attempt, result = null, error = null, status = "completed" } = {}) {
    const reported = result?.points || error?.modelUsage?.points || null;
    const remaining = result?.remainingPoints ?? error?.modelUsage?.remainingPoints ?? this.account().points;
    const event = {
      id: ++this.modelUsageSequence,
      task: String(request?.task || "unknown"),
      label: String(label || "模型请求"),
      attempt: Math.max(1, Math.trunc(Number(attempt || 1))),
      status,
      points: {
        input: modelPointNumber(reported?.input),
        output: modelPointNumber(reported?.output),
        total: modelPointNumber(reported?.total),
        source: String(reported?.source || "platform-unavailable")
      },
      remainingPoints: remaining == null ? null : String(remaining),
      completedAt: this.now()
    };
    this.modelUsageEvents.push(event);
    if (this.modelUsageEvents.length > 30) this.modelUsageEvents.splice(0, this.modelUsageEvents.length - 30);
    this.saveCache();
    this.notify();
    return event;
  }

  recordLocalEvent(event) {
    if (!event) return;
    this.localEvents.push(cloneJson(event));
    if (this.localEvents.length > 2000) this.localEvents.splice(0, this.localEvents.length - 2000);
    this.diagnostic({ event: "player-behavior", source: "local", behavior: cloneJson(event) });
  }

  captureLocalOverlay(sourceWorld = this.world) {
    if (!sourceWorld) return null;
    const accountId = this.account().accountId;
    const allowed = candidate => String(candidate) === accountId;
    const deployedGeneralProgress = {
      ...deployedGeneralProgressFor(sourceWorld, accountId),
      ...this.localDeployedGeneralProgress
    };
    return {
      playerEpoch: Math.max(0, Math.trunc(Number(sourceWorld.playerEpochs?.[accountId] || 0))),
      completeOwnGeneralArchive: true,
      privatePlayers: Object.fromEntries(Object.entries(sourceWorld.privatePlayers || {}).filter(([id]) => allowed(id)).map(([id, value]) => [id, cloneJson(value)])),
      players: Object.fromEntries(Object.entries(sourceWorld.players || {}).filter(([id]) => allowed(id)).map(([id, player]) => [id, {
        ...(finiteStoredNumber(player.gold) ? { gold: Number(player.gold) } : {}),
        ...(finiteStoredNumber(player.basePower) ? { basePower: Number(player.basePower) } : {}),
        ...(finiteStoredNumber(player.trainingLevel) ? { trainingLevel: Number(player.trainingLevel) } : {}),
        ...(finiteStoredNumber(player.cultivationCount) ? { cultivationCount: Number(player.cultivationCount) } : {}),
        ...(finiteStoredNumber(player.power) ? { power: Number(player.power) } : {}),
        ...(finiteStoredNumber(player.fieldArmySoldiers) ? { fieldArmySoldiers: Number(player.fieldArmySoldiers) } : {}),
        ...(Object.hasOwn(player, "carriedGeneralIds") ? { carriedGeneralIds: [...(player.carriedGeneralIds || [])] } : {}),
        ...(validPosition(player.position) ? { position: { x: Number(player.position.x), y: Number(player.position.y) } } : {}),
        ...(validRetreatPath(player.retreatPath, player.position) ? { retreatPath: player.retreatPath.map(point => ({ x: Number(point.x), y: Number(point.y) })) } : {}),
        ...(finiteStoredNumber(player.joinedAt) ? { joinedAt: Number(player.joinedAt) } : {})
      }])),
      // The public ledger only carries deployed projections. Keep every full
      // local archive so a recall/cultivation followed by a disconnect cannot
      // turn a public tombstone into permanent local data loss.
      generals: Object.fromEntries(Object.entries(sourceWorld.generals || {}).filter(([, general]) => allowed(general.holderAccountId)).map(([id, general]) => [id, cloneJson(general)])),
      generalOrders: Object.fromEntries(Object.keys(sourceWorld.generals || {}).map(id => [id, cloneJson(
        compareOrderValue(this.localGeneralArchiveOrders[id], this.publicGeneralOrders[id]) > 0
          ? this.localGeneralArchiveOrders[id] : this.publicGeneralOrders[id] || ledgerOrder(null)
      )])),
      deployedGeneralProgress,
      jobs: Object.fromEntries(Object.entries(sourceWorld.jobs || {}).filter(([, job]) => allowed(job.accountId)).map(([id, job]) => [id, cloneJson(job)])),
      processedIntents: [...(sourceWorld.processedIntents || [])]
    };
  }

  replaceLocalOverlay(overlay) {
    if (!this.world || !overlay) return false;
    normalizeWorldState(this.world);
    const accountId = this.account().accountId;
    const currentEpoch = Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[accountId] || 0)));
    if (!accountId || Math.max(0, Math.trunc(Number(overlay.playerEpoch || 0))) !== currentEpoch) return false;
    for (const [id, job] of Object.entries(this.world.jobs || {})) {
      if (String(job?.accountId || "") === accountId) delete this.world.jobs[id];
    }
    delete this.world.privatePlayers[accountId];
    const player = this.world.players?.[accountId];
    if (player) {
      for (const field of ["gold", "basePower", "trainingLevel", "power", "fieldArmySoldiers", "carriedGeneralIds", "position", "retreatPath", "joinedAt"]) delete player[field];
      Object.assign(player, cloneJson(overlay.players?.[accountId] || {}));
    }
    if (overlay.privatePlayers?.[accountId]) this.world.privatePlayers[accountId] = cloneJson(overlay.privatePlayers[accountId]);
    this.restoreGeneralArchives(overlay);
    Object.assign(this.world.jobs, cloneJson(overlay.jobs || {}));
    this.world.processedIntents = [...new Set(overlay.processedIntents || [])].slice(-1000);
    this.localDeployedGeneralProgress = cloneJson(overlay.deployedGeneralProgress || {});
    this.applyLocalDeployedGeneralProgress();
    this.recoverOwnLocalPlayerState();
    this.pruneForeignPrivateState();
    this.reconcileMarketSales();
    return true;
  }

  prepareIntentTransaction({ beforeWorld, mapDeltaId, intentType, eventId, changes = null }) {
    this.pendingIntentTransaction = {
      version: 1,
      transactionId: crypto.randomUUID(),
      mapDeltaId: String(mapDeltaId),
      workId: String(this.work?.id || ""),
      seasonId: String(this.control?.seasonId || ""),
      accountId: this.account().accountId,
      playerEpoch: Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[this.account().accountId] || 0))),
      intentType: String(intentType || "unknown").slice(0, 80),
      eventId: String(eventId || ""),
      beforeOverlay: this.captureLocalOverlay(beforeWorld),
      afterOverlay: this.captureLocalOverlay(this.world),
      changes: changes ? cloneJson(changes) : null,
      phase: "prepared",
      createdAt: this.now()
    };
    this.saveCache();
    return this.pendingIntentTransaction;
  }

  async retryPendingIntentTransactionPublish() {
    const transaction = this.pendingIntentTransaction;
    if (!transaction || transaction.phase !== "prepared" || !hasPublicMapChanges(transaction.changes)) return null;
    const validSession = String(transaction.workId || "") === String(this.work?.id || "")
      && String(transaction.seasonId || "") === String(this.control?.seasonId || "")
      && String(transaction.accountId || "") === this.account().accountId
      && Math.max(0, Math.trunc(Number(transaction.playerEpoch || 0))) === Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[this.account().accountId] || 0)));
    if (!validSession) return null;
    const identity = await this.getIdentity();
    const record = await this.publishMapChanges(transaction.changes, identity, { mapDeltaId: transaction.mapDeltaId });
    transaction.phase = "published";
    transaction.publishedAt = this.now();
    if (this.lastPublishedMapOrder?.mapDeltaId === transaction.mapDeltaId) {
      transaction.publishedOrder = cloneJson(this.lastPublishedMapOrder.order);
    }
    this.saveCache();
    this.diagnostic({
      event: "intent-transaction-publish-retried",
      transactionId: transaction.transactionId,
      mapDeltaId: transaction.mapDeltaId,
      intentType: transaction.intentType
    });
    return record;
  }

  applyCommittedTransactionChanges(changes, publishedOrder = null) {
    if (!this.world || !changes || typeof changes !== "object") return false;
    for (const [key, cell] of Object.entries(changes.cells || {})) {
      if (publishedOrder && compareOrderValue(this.publicCellOrders[key], publishedOrder) > 0) continue;
      const envelope = occupationEnvelope(changes, key);
      const nextCell = envelope.modern ? envelope.nextCell : cell;
      if (nextCell == null) delete this.world.cells[key];
      else this.world.cells[key] = cloneJson(nextCell);
    }
    for (const [id, general] of Object.entries(changes.generals || {})) {
      if (publishedOrder && compareOrderValue(this.publicGeneralOrders[id], publishedOrder) > 0) continue;
      if (general != null) {
        this.world.generals[id] = { ...(this.world.generals[id] || {}), ...publicGeneralState(general) };
        continue;
      }
      const transition = changes.generalTransitions?.[id];
      const locationKey = validGeneralTransitionShape(id, transition) ? `${transition.from.x},${transition.from.y}` : "";
      const locationEnvelope = locationKey ? occupationEnvelope(changes, locationKey) : null;
      const nextCell = locationEnvelope?.modern ? locationEnvelope.nextCell : locationKey ? changes.cells?.[locationKey] : null;
      if (!locationKey || !isPublicCellShape(nextCell) || (nextCell.generalIds || []).map(String).includes(String(id))) continue;
      if (this.world.generals[id]?.status === "deployed") delete this.world.generals[id];
    }
    this.world.marketListings ||= {};
    this.world.marketSales ||= {};
    for (const [id, listing] of Object.entries(changes.marketListings || {})) {
      if (listing == null) delete this.world.marketListings[id];
      else this.world.marketListings[id] = cloneJson(listing);
    }
    for (const [id, sale] of Object.entries(changes.marketSales || {})) if (sale != null) this.world.marketSales[id] = cloneJson(sale);
    this.world.claimedTreasures ||= {};
    for (const [id, claim] of Object.entries(changes.claimedTreasures || {})) {
      if (claim == null) continue;
      this.world.claimedTreasures[id] = cloneJson(claim);
      delete this.world.treasureSpawns[id];
    }
    this.rememberConquests(changes.conquests);
    return true;
  }

  resolvePendingIntentTransaction() {
    const transaction = this.pendingIntentTransaction;
    if (!transaction || !this.world) return false;
    const validSession = String(transaction.workId || "") === String(this.work?.id || "")
      && String(transaction.seasonId || "") === String(this.control?.seasonId || "")
      && String(transaction.accountId || "") === this.account().accountId
      && Math.max(0, Math.trunc(Number(transaction.playerEpoch || 0))) === Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[this.account().accountId] || 0)));
    const published = validSession && this.appliedMapDeltaIds.has(String(transaction.mapDeltaId || ""));
    if (validSession && !published && transaction.changes) return false;
    const overlay = validSession ? (published ? transaction.afterOverlay : transaction.beforeOverlay) : null;
    if (validSession && !published && transaction.beforeOverlay?.completeOwnGeneralArchive && transaction.afterOverlay?.completeOwnGeneralArchive) {
      for (const id of Object.keys(transaction.afterOverlay.generals || {})) {
        if (!Object.hasOwn(transaction.beforeOverlay.generals || {}, id)
          && String(this.world.generals?.[id]?.holderAccountId || "") === this.account().accountId) delete this.world.generals[id];
      }
    }
    if (published && transaction.changes) this.applyCommittedTransactionChanges(transaction.changes, transaction.publishedOrder);
    if (overlay) this.replaceLocalOverlay(overlay);
    if (validSession && !published && transaction.eventId) {
      this.localEvents = this.localEvents.filter(event => String(event?.eventId || "") !== String(transaction.eventId));
    }
    this.diagnostic({
      event: "intent-transaction-recovered",
      status: published ? "committed" : validSession ? "rolled-back" : "discarded",
      transactionId: transaction.transactionId,
      mapDeltaId: transaction.mapDeltaId,
      intentType: transaction.intentType
    });
    this.pendingIntentTransaction = null;
    return true;
  }

  captureLedgerRuntimeState() {
    return {
      publicDeltaCountSinceSnapshot: Number(this.publicDeltaCountSinceSnapshot || 0),
      publicMapOrder: cloneJson(this.publicMapOrder),
      publicMapBaselineOrder: cloneJson(this.publicMapBaselineOrder),
      publicHistoryOrder: cloneJson(this.publicHistoryOrder),
      publicTreasureSources: cloneJson(this.publicTreasureSources),
      knownCommentIds: [...this.knownCommentIds],
      historyTailPage: Number(this.historyTailPage || 1),
      historyPageOrder: String(this.historyPageOrder || "unknown"),
      commentRootPages: [...this.commentRootPages]
    };
  }

  restoreLedgerRuntimeState(state) {
    if (!state || typeof state !== "object") return;
    this.publicDeltaCountSinceSnapshot = Math.max(0, Number(state.publicDeltaCountSinceSnapshot || 0));
    this.publicMapOrder = ledgerOrder(state.publicMapOrder);
    this.publicMapBaselineOrder = ledgerOrder(state.publicMapBaselineOrder);
    this.publicHistoryOrder = ledgerOrder(state.publicHistoryOrder);
    this.publicTreasureSources = cloneJson(state.publicTreasureSources || {});
    this.knownCommentIds = new Set(Array.isArray(state.knownCommentIds) ? state.knownCommentIds.map(String).slice(-500) : []);
    this.historyTailPage = Math.max(1, Math.trunc(Number(state.historyTailPage || 1)));
    this.historyPageOrder = ["oldest-first", "newest-first", "mixed"].includes(state.historyPageOrder)
      ? state.historyPageOrder : "unknown";
    this.commentRootPages = new Map(Array.isArray(state.commentRootPages) ? state.commentRootPages.slice(-2000) : []);
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
      delete player.basePower;
      delete player.trainingLevel;
      delete player.power;
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
    if (!overlay) this.localDeployedGeneralProgress = {};
    this.localDeployedGeneralProgress = {
      ...this.localDeployedGeneralProgress,
      ...(overlay?.deployedGeneralProgress && typeof overlay.deployedGeneralProgress === "object"
        ? cloneJson(overlay.deployedGeneralProgress)
        : {})
    };
    if (overlay) {
      Object.assign(this.world.privatePlayers, overlay.privatePlayers || {});
      for (const [accountId, fields] of Object.entries(overlay.players || {})) if (this.world.players[accountId]) Object.assign(this.world.players[accountId], fields);
      this.restoreGeneralArchives(overlay);
      Object.assign(this.world.jobs, overlay.jobs || {});
      this.world.processedIntents = [...new Set([...(this.world.processedIntents || []), ...(overlay.processedIntents || [])])].slice(-1000);
    }
    this.applyLocalDeployedGeneralProgress();
    if (accountId && this.world.players[accountId]) {
      this.world.privatePlayers[accountId] ||= {};
      this.world.privatePlayers[accountId].orientation = this.localPreferences.orientation;
      this.world.privatePlayers[accountId].characterProfileId = this.localPreferences.characterProfileId;
      this.world.privatePlayers[accountId].characterTags = [...this.localPreferences.characterTags];
      this.world.privatePlayers[accountId].initialGeneralWish = this.localPreferences.initialGeneralWish;
      this.world.privatePlayers[accountId].playerContext = cloneJson(this.localPreferences.playerContext);
    }
    this.applyAuthorityPlayerActions();
    this.recoverOwnLocalPlayerState();
    this.pruneForeignPrivateState();
    this.reconcileMarketSales();
  }

  restoreGeneralArchives(overlay) {
    for (const [id, local] of Object.entries(overlay?.generals || {})) {
      const remote = this.world.generals[id];
      const localOrder = ledgerOrder(overlay.generalOrders?.[id]);
      const remoteOrder = ledgerOrder(this.publicGeneralOrders[id]);
      const cell = remote?.location && this.world.cells[`${remote.location.x},${remote.location.y}`];
      const verifiedDeployment = remote?.status === "deployed"
        && cell?.ownerAccountId === remote.holderAccountId && cell.generalIds?.includes(id)
        && remoteOrder.timestamp > 0 && compareOrderValue(remoteOrder, localOrder) >= 0;
      this.world.generals[id] = verifiedDeployment ? mergeGeneralHistories(local, remote) : cloneJson(local);
      this.localGeneralArchiveOrders[id] = verifiedDeployment ? remoteOrder : localOrder;
    }
    this.reconcileGeneralRecalls();
  }

  reconcileGeneralRecalls() {
    const viewer = this.account().accountId;
    for (const [id, proof] of Object.entries(this.publicGeneralRecalls || {})) {
      const { transition, order } = proof || {};
      if (!validGeneralTransitionShape(id, transition) || transition.reason !== "recalled"
        || Number(proof.playerEpoch || 0) !== Number(this.world.playerEpochs?.[transition.holderAccountId] || 0)
        || compareOrderValue(order, this.publicGeneralOrders[id]) < 0
        || compareOrderValue(order, this.localGeneralArchiveOrders[id]) < 0) continue;
      const cell = this.world.cells[`${transition.from.x},${transition.from.y}`];
      if (cell?.generalIds?.includes(id)) continue;
      let general = this.world.generals[id];
      const archive = proof.general;
      if (!general && transition.holderAccountId === viewer && archive?.id === id
        && archive.holderAccountId === viewer && archive.status === "deployed"
        && archive.location?.x === transition.from.x && archive.location?.y === transition.from.y) {
        general = this.world.generals[id] = cloneJson(archive);
      }
      if (!general || general.holderAccountId !== transition.holderAccountId) continue;
      if (general.holderAccountId === viewer) {
        general.status = "carried";
        general.location = null;
        const player = this.world.players[viewer];
        if (player) player.carriedGeneralIds = [...new Set([...(player.carriedGeneralIds || []), id])];
        this.localGeneralArchiveOrders[id] = ledgerOrder(order);
      } else if (general.status === "deployed") delete this.world.generals[id];
    }
  }

  recoverLegacyGeneralRecalls(records) {
    for (const item of records || []) {
      const record = item.record;
      if (record?.schema !== FYOW_SCHEMAS.mapDelta || record.workId !== this.work?.id
        || record.seasonId !== this.control?.seasonId || record.gameId !== GRID_GAME_ID
        || Object.hasOwn(record.changes || {}, "generalTransitions")
        || !verifySignedRecord(record, record.deviceSigningPublicKey)
        || !(item.sources || []).length || !item.sources.every(source => commentAccountId(source) === record.actorAccountId)
        || Number(record.playerEpoch || 0) !== Number(this.world.playerEpochs?.[record.actorAccountId] || 0)) continue;
      const order = recordPlatformOrder(item);
      for (const [id, value] of Object.entries(record.changes?.generals || {})) {
        if (value !== null || compareOrderValue(order, this.publicGeneralOrders[id]) !== 0) continue;
        const general = this.world.generals[id];
        if (!general || general.status !== "deployed" || general.holderAccountId !== record.actorAccountId
          || !validPosition(general.location)) continue;
        const key = `${general.location.x},${general.location.y}`;
        const next = record.changes.cells?.[key];
        const current = this.world.cells[key];
        if (!isPublicCellShape(next) || next.ownerAccountId !== record.actorAccountId || next.generalIds.includes(id)
          || current?.ownerAccountId !== record.actorAccountId || current.generalIds?.includes(id)
          || compareOrderValue(this.publicCellOrders[key], order) < 0) continue;
        this.publicGeneralRecalls[id] = {
          order, general: publicGeneralState(general), playerEpoch: Number(record.playerEpoch || 0),
          transition: { generalId: id, holderAccountId: record.actorAccountId, from: cloneJson(general.location),
            reason: "recalled", targetStatus: "carried", nextHolderAccountId: record.actorAccountId }
        };
        this.diagnostic({ event: "general-location-reconciled", generalId: id, mapDeltaId: record.mapDeltaId, reason: "verified-legacy-recall" });
      }
    }
    this.reconcileGeneralRecalls();
  }

  applyLocalDeployedGeneralProgress() {
    if (!this.world) return;
    const accountId = this.account().accountId;
    for (const [generalId, progress] of Object.entries(this.localDeployedGeneralProgress || {})) {
      const general = this.world.generals?.[generalId];
      if (!general || general.status !== "deployed" || String(general.holderAccountId || "") !== accountId) continue;
      if (Number(progress?.cultivationCount || 0) !== Number(general.cultivationCount || 0)) continue;
      const required = generalExperienceRequirement(general);
      if (!required) continue;
      general.experience = Math.min(required, Math.max(Number(general.experience || 0), Number(progress.experience || 0)));
      general.experienceUpdatedAt = Math.max(Number(general.experienceUpdatedAt || 0), Number(progress.experienceUpdatedAt || 0));
    }
  }

  reconcileMarketSales() {
    for (const sale of Object.values(this.world?.marketSales || {})) this.applyMarketSaleToSeller(sale);
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
        if (["train", "power-train", "cultivate-player", "cultivate-general", "march"].includes(event?.type)) gold -= Math.max(0, Number(event?.result?.cost || 0));
        if (event?.type === "time-settle") for (const effect of event?.result?.effects || []) {
          if (effect?.type === "mining-complete" && String(effect.accountId || "") === accountId) gold += Math.max(0, Number(effect.gold || 0));
        }
      }
      player.gold = Math.max(0, gold); changed = true;
    }
    if (!finiteStoredNumber(player.fieldArmySoldiers)) { player.fieldArmySoldiers = 0; changed = true; }
    const previousPower = player.power;
    const previousBasePower = player.basePower;
    const previousTrainingLevel = player.trainingLevel;
    ensurePowerProgress(player, 300);
    if (player.power !== previousPower || player.basePower !== previousBasePower || player.trainingLevel !== previousTrainingLevel) changed = true;
    const carriedIds = Object.entries(this.world.generals || {})
      .filter(([, general]) => String(general?.holderAccountId || "") === accountId && general?.status === "carried")
      .map(([id]) => id);
    const orderedIds = [...new Set([...(player.carriedGeneralIds || []), ...carriedIds])].filter(id => carriedIds.includes(id));
    if (canonicalJson(player.carriedGeneralIds || null) !== canonicalJson(orderedIds)) {
      player.carriedGeneralIds = orderedIds;
      changed = true;
    }
    if (!finiteStoredNumber(player.joinedAt) && joinEvent) { player.joinedAt = Number(joinEvent.createdAt || this.world.startedAt || this.now()); changed = true; }
    return changed;
  }

  loadCache(workId) {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return null;
    try {
      const root = readJsonWithBackupSync(fs, this.cacheFile, value => (
        value?.version === 1 && value?.worlds && typeof value.worlds === "object"
      ) || (
        value?.version === 2 && value?.accounts && typeof value.accounts === "object"
      )).value;
      const accountId = this.account().accountId;
      if (!accountId) return null;
      if (root?.version === 2) {
        const cached = root.accounts?.[accountId]?.worlds?.[workId];
        if (cached) return cached;
        const legacy = root.legacyWorlds?.[workId];
        return this.cacheOwnerAccountId(legacy) === accountId ? legacy : null;
      }
      const legacy = root?.worlds?.[workId];
      return this.cacheOwnerAccountId(legacy) === accountId ? legacy : null;
    } catch { return null; }
  }

  verifiedCachedServer(card, cached = null) {
    if (!card?.companion?.workId || !card?.companion?.authorAccountId) return null;
    const accountId = this.account().accountId;
    const workId = String(card.companion.workId);
    const authorityAccountId = String(card.companion.authorAccountId);
    const candidate = cached || this.loadCache(workId);
    const control = candidate?.control;
    const world = candidate?.world;
    if (!accountId || !candidate || this.cacheOwnerAccountId(candidate) !== accountId) return null;
    if (!control || !world || world.gameId !== GRID_GAME_ID || control.gameId !== GRID_GAME_ID) return null;
    if (String(control.workId || "") !== workId || String(control.authorityAccountId || "") !== authorityAccountId) return null;
    if (String(control.seasonId || "") !== String(world.seasonId || "")) return null;
    if (world.authorityAccountId && String(world.authorityAccountId) !== authorityAccountId) return null;
    if (!control.authoritySigningPublicKey || !verifySignedRecord(control, control.authoritySigningPublicKey)) return null;
    return candidate;
  }

  clearCacheForWork(workId) {
    const targetWorkId = String(workId || "");
    const accountId = this.account().accountId;
    if (!this.cacheFile || !targetWorkId || !accountId || !fs.existsSync(this.cacheFile)) return false;
    try {
      const root = readJsonWithBackupSync(fs, this.cacheFile, value => (
        value?.version === 2 && value?.accounts && typeof value.accounts === "object"
      ) || (
        value?.version === 1 && value?.worlds && typeof value.worlds === "object"
      )).value;
      if (root?.version === 2) {
        const worlds = root.accounts?.[accountId]?.worlds;
        if (!worlds || !Object.hasOwn(worlds, targetWorkId)) return false;
        delete worlds[targetWorkId];
      } else if (root?.version === 1 && Object.hasOwn(root.worlds || {}, targetWorkId)) {
        delete root.worlds[targetWorkId];
      } else return false;
      atomicWriteJsonSync(fs, this.cacheFile, root, { pretty: true });
      return true;
    } catch { return false; }
  }

  cacheOwnerAccountId(cached) {
    if (!cached || typeof cached !== "object") return "";
    if (cached.cacheAccountId) return String(cached.cacheAccountId);
    const candidates = new Set([
      ...Object.keys(cached.localOverlay?.privatePlayers || {}),
      ...Object.keys(cached.localOverlay?.players || {})
    ].map(String).filter(Boolean));
    return candidates.size === 1 ? [...candidates][0] : "";
  }

  saveCache() {
    if (!this.cacheFile || !this.work || !this.world) return;
    const accountId = this.account().accountId;
    if (!accountId) return;
    let root = { version: 2, accounts: {}, legacyWorlds: {} };
    try {
      if (fs.existsSync(this.cacheFile)) {
        const existing = readJsonWithBackupSync(fs, this.cacheFile, value => (
          value?.version === 1 && value?.worlds && typeof value.worlds === "object"
        ) || (
          value?.version === 2 && value?.accounts && typeof value.accounts === "object"
        )).value;
        if (existing?.version === 2) root = {
          version: 2,
          accounts: existing.accounts || {},
          legacyWorlds: existing.legacyWorlds || {}
        };
        else if (existing?.version === 1) root.legacyWorlds = existing.worlds || {};
      }
    } catch {}
    root.accounts[accountId] ||= { worlds: {} };
    root.accounts[accountId].worlds ||= {};
    const directSession = this.directSession();
    const directInbox = this.directInbox.filter(item => this.directItemMatchesSession(item, directSession)).slice(-100);
    const directHistory = this.directHistory.filter(item => this.directItemMatchesSession(item, directSession)).slice(-200);
    root.accounts[accountId].worlds[this.work.id] = {
      cacheAccountId: accountId,
      control: this.control,
      controlPlatformOrder: { ...this.controlPlatformOrder },
      world: cacheWorldForPersistence(this.world),
      localOverlay: this.captureLocalOverlay(),
      publicArchivesRequireRefresh: true,
      localEvents: this.localEvents.slice(-2000),
      appliedMapDeltaIds: [...this.appliedMapDeltaIds].slice(-4000),
      appliedAuthorityIds: [...this.appliedAuthorityIds].slice(-1000),
      publicDeltaCountSinceSnapshot: this.publicDeltaCountSinceSnapshot,
      publicMapOrder: { ...this.publicMapOrder },
      publicMapBaselineOrder: { ...this.publicMapBaselineOrder },
      publicHistoryOrder: { ...this.publicHistoryOrder },
      publicCellOrders: this.publicCellOrders,
      publicCellWriteBases: this.publicCellWriteBases,
      publicGeneralOrders: this.publicGeneralOrders,
      publicGeneralRecalls: this.publicGeneralRecalls,
      publicMarketOrders: this.publicMarketOrders,
      publicMarketSaleOrders: this.publicMarketSaleOrders,
      marketSettledSales: [...this.marketSettledSales].slice(-1000),
      publicParticipantOrders: this.publicParticipantOrders,
      publicAuthorityOrders: this.publicAuthorityOrders,
      publicTreasureSources: this.publicTreasureSources,
      directSession,
      directInbox,
      directHistory,
      worldChat: this.currentWorldChat(),
      worldChatCursor: cloneJson(this.worldChatCursor),
      localPreferences: cloneJson(this.localPreferences),
      seenDirectMessageIds: [...this.seenDirectMessageIds].slice(-500),
      pendingModelEffects: cloneJson(this.pendingModelEffects.slice(-50)),
      pendingIntentTransaction: this.pendingIntentTransaction ? cloneJson(this.pendingIntentTransaction) : null,
      migrationDraft: this.migrationDraft ? cloneJson(this.migrationDraft) : null,
      modelUsageEvents: cloneJson(this.modelUsageEvents.slice(-30)),
      modelUsageSequence: this.modelUsageSequence,
      knownCommentIds: [...this.knownCommentIds].slice(-500),
      historyTailPage: this.historyTailPage,
      historyPageOrder: this.historyPageOrder,
      commentRootPages: [...this.commentRootPages].slice(-2000),
      updatedAt: this.now()
    };
    if (this.cacheOwnerAccountId(root.legacyWorlds[this.work.id]) === accountId) delete root.legacyWorlds[this.work.id];
    atomicWriteJsonSync(fs, this.cacheFile, root, { pretty: false });
  }

  saveMigrationDraftForSource(sourceWork, sourceControl) {
    const activeWork = this.work;
    const activeControl = this.control;
    const activeRuntime = this.captureLedgerRuntimeState();
    try {
      this.work = sourceWork;
      this.control = sourceControl;
      this.restoreLedgerRuntimeState(this.migrationDraft?.sourceLedgerRuntime);
      this.saveCache();
    } finally {
      this.work = activeWork;
      this.control = activeControl;
      this.restoreLedgerRuntimeState(activeRuntime);
    }
  }

  startPolling() {
    this.syncPaused = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const schedule = delay => {
      if (this.syncPaused) return;
      this.pollTimer = setTimeout(async () => {
        if (this.syncPaused) return;
        try {
          await this.sync(false);
          this.pollFailureCount = 0;
        } catch {
          this.pollFailureCount += 1;
        } finally {
          const retryDelay = Math.min(POLL_RETRY_MAX_MS, POLL_INTERVAL_MS * (2 ** Math.min(4, this.pollFailureCount)));
          schedule(retryDelay);
        }
      }, delay);
    };
    schedule(POLL_INTERVAL_MS);
  }

  close() {
    this.syncPaused = true;
    this.onClose?.();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollFailureCount = 0;
    this.pendingJoinPreview = null;
    this.saveCache();
    this.status = "closed";
    this.notify();
  }

  async pause() {
    this.loadProgress = null;
    this.close();
    await Promise.allSettled([this.syncInFlight, this.intentInFlight, this.joinInFlight, this.migrationInFlight].filter(Boolean));
    this.saveCache();
    this.status = "closed";
    this.loadProgress = null;
    this.notify();
    return this.state();
  }

  async forgetOpenedCard() {
    await this.pause();
    this.card = null;
    this.work = null;
    this.program = builtInGridProgram();
    this.control = null;
    this.controlPlatformOrder = { timestamp: 0, commentId: "" };
    this.world = null;
    this.error = null;
    this.pendingMigration = null;
    this.migrationProof = null;
    this.migrationDraft = null;
    this.pendingJoinPreview = null;
    this.localEvents = [];
    this.localDeployedGeneralProgress = {};
    this.localGeneralArchiveOrders = {};
    this.publicGeneralRecalls = {};
    this.directInbox = [];
    this.directHistory = [];
    this.seenDirectMessageIds.clear();
    this.worldChat = [];
    this.mapFactsCache = null;
    this.notify();
    return this.state();
  }

  assertSyncActive() {
    if (this.syncPaused) throw new Error("游戏已暂停");
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

  async fetchLiveProgramDescription(card, workId) {
    if (!workId) return null;
    try {
      const payload = await this.requestGo(`/apps/${encodeURIComponent(workId)}`, { timeout: 30000 });
      const description = normalizeWorkDetail(payload, workId).description;
      if (!parseProgram(description, String(card?.gameId || GRID_GAME_ID))) {
        throw new Error("当前伴生作品页面没有有效游戏程序包");
      }
      return description;
    } catch (error) {
      this.diagnostic({
        event: "work-program-refresh-failed",
        status: "degraded",
        source: "companion-work-page",
        error: error?.message || String(error),
        workId
      });
      return null;
    }
  }

  async open({ card, workUrl, orientation, displayName, migrationProof = null } = {}) {
    const previousWorkId = String(this.work?.id || "");
    await this.pause();
    this.syncPaused = false;
    this.pendingMigration = null;
    this.migrationProof = migrationProof && typeof migrationProof === "object" ? cloneJson(migrationProof) : null;
    // The cache loaded below is scoped to the referenced work. Drop the
    // previous session's experience overlay before restoring that cache.
    this.localDeployedGeneralProgress = {};
    this.localGeneralArchiveOrders = {};
    this.pendingIntentTransaction = null;
    const account = this.account();
    if (!account.accountId) throw new Error("请先登录风月账号");
    const origin = String(this.getOrigin?.() || "").replace(/\/$/, "");
    const normalizedCard = card ? validateGameCard(card) : null;
    const fixedWorkUrl = normalizedCard ? `${origin}/zh/explore/installed/${encodeURIComponent(normalizedCard.companion.workId)}` : workUrl;
    const reference = workReference(fixedWorkUrl, origin);
    if (normalizedCard && reference.workId !== normalizedCard.companion.workId) throw new Error("游戏卡绑定的伴生作品编号不一致");
    this.status = "opening";
    this.loadProgress = { schema: "fyow.load-progress/1", active: true, phase: "preparing", readComments: 0, totalComments: null };
    this.error = null;
    this.pendingJoinPreview = null;
    // Never project the previous server while a different work is being
    // opened. The old projection was the source of a brief, misleading
    // "wrong record" view during migration retries.
    if (previousWorkId && previousWorkId !== reference.workId) {
      this.control = null;
      this.world = null;
      this.localEvents = [];
      this.directInbox = [];
      this.directHistory = [];
      this.seenDirectMessageIds.clear();
    }
    this.notify();
    await this.calibrateClock().catch(() => null);
    this.experienceSessionStartedAt = this.now();
    this.card = normalizedCard;
    const cached = this.loadCache(reference.workId);
    const verifiedCachedServer = normalizedCard ? this.verifiedCachedServer(normalizedCard, cached) : null;
    let workDetailError = null;
    const liveDescriptionPromise = this.fetchLiveProgramDescription(normalizedCard, reference.workId);
    try {
      const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(reference.workId)}`);
      this.work = { ...normalizeWorkDetail(payload, reference.workId), url: reference.url };
    } catch (error) {
      if (!verifiedCachedServer || this.migrationProof) throw error;
      workDetailError = error;
      this.work = {
        id: reference.workId,
        name: String(normalizedCard.companion.name || normalizedCard.title || "在线游戏世界"),
        description: String(normalizedCard.companion.configuration?.app?.description || ""),
        authorAccountId: String(normalizedCard.companion.authorAccountId),
        authorName: String(normalizedCard.companion.authorName || ""),
        url: reference.url
      };
      this.diagnostic({
        event: "work-detail-cache-fallback",
        status: "degraded",
        error: error?.message || String(error),
        workId: reference.workId
      });
    }
    if (normalizedCard?.companion?.authorAccountId && this.work.authorAccountId !== normalizedCard.companion.authorAccountId) throw new Error("伴生作品当前作者与游戏卡绑定的服主账号不一致");
    if (this.migrationProof?.authorityAccountId && String(this.work.authorAccountId || "") !== String(this.migrationProof.authorityAccountId)) {
      throw new Error("迁移目标作品作者与源服务器不一致");
    }
    if (normalizedCard && this.work.name === "在线游戏世界") this.work.name = normalizedCard.companion.name;
    const liveDescription = await liveDescriptionPromise;
    this.loadWorkProgram(normalizedCard, liveDescription);
    this.mapFactsCache = null;
    this.knownCommentIds = new Set(Array.isArray(cached?.knownCommentIds) ? cached.knownCommentIds.slice(-500).map(String) : []);
    this.historyTailPage = Math.max(1, Math.trunc(Number(cached?.historyTailPage || 1)));
    this.historyPageOrder = ["oldest-first", "newest-first", "mixed"].includes(cached?.historyPageOrder) ? cached.historyPageOrder : "unknown";
    this.commentRootPages = new Map((Array.isArray(cached?.commentRootPages) ? cached.commentRootPages : [])
      .filter(entry => Array.isArray(entry) && typeof entry[0] === "string" && Number.isSafeInteger(entry[1]) && entry[1] > 0 && entry[1] <= MAX_HISTORY_PAGES)
      .slice(-2000));
    this.localEvents = Array.isArray(cached?.localEvents) ? cached.localEvents.slice(-2000) : [];
    this.worldChat = Array.isArray(cached?.worldChat) ? cached.worldChat.slice(-WORLD_CHAT_LIMIT) : [];
    this.worldChatSendTimes = [];
    this.worldChatCursor = cached?.worldChatCursor && typeof cached.worldChatCursor === "object"
      ? cloneJson(cached.worldChatCursor) : null;
    this.pendingModelEffects = Array.isArray(cached?.pendingModelEffects) ? cached.pendingModelEffects.slice(-50) : [];
    this.pendingIntentTransaction = cached?.pendingIntentTransaction && typeof cached.pendingIntentTransaction === "object"
      ? cloneJson(cached.pendingIntentTransaction)
      : null;
    this.migrationDraft = cached?.migrationDraft && typeof cached.migrationDraft === "object"
      ? cloneJson(cached.migrationDraft) : null;
    if (this.migrationDraft
      && String(this.migrationDraft.sourceWorkId || "") === String(this.work.id)
      && String(this.migrationDraft.newWorkId || "")) {
      this.pendingMigration = {
        workId: String(this.migrationDraft.newWorkId),
        url: String(this.migrationDraft.newWorkUrl || ""),
        exportSha256: String(this.migrationDraft.exportSha256 || ""),
        configurationImported: Boolean(this.migrationDraft.configurationImported),
        newLedgerInitialized: Boolean(this.migrationDraft.targetLedgerInitialized),
        targetLedgerVerified: Boolean(this.migrationDraft.targetLedgerVerified),
        redirectPublished: false,
        requiresPublish: true
      };
    }
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
    this.publicHistoryOrder = ledgerOrder(cached?.publicHistoryOrder);
    this.controlPlatformOrder = ledgerOrder(cached?.controlPlatformOrder);
    this.publicCellOrders = cached?.publicCellOrders && typeof cached.publicCellOrders === "object" ? cached.publicCellOrders : {};
    this.publicCellWriteBases = cached?.publicCellWriteBases && typeof cached.publicCellWriteBases === "object" ? cached.publicCellWriteBases : {};
    this.publicGeneralOrders = cached?.publicGeneralOrders && typeof cached.publicGeneralOrders === "object" ? cached.publicGeneralOrders : {};
    this.publicGeneralRecalls = cached?.publicGeneralRecalls && typeof cached.publicGeneralRecalls === "object" ? cached.publicGeneralRecalls : {};
    this.publicMarketOrders = cached?.publicMarketOrders && typeof cached.publicMarketOrders === "object" ? cached.publicMarketOrders : {};
    this.publicMarketSaleOrders = cached?.publicMarketSaleOrders && typeof cached.publicMarketSaleOrders === "object" ? cached.publicMarketSaleOrders : {};
    this.marketSettledSales = new Set(Array.isArray(cached?.marketSettledSales) ? cached.marketSettledSales.slice(-1000).map(String) : []);
    this.publicParticipantOrders = cached?.publicParticipantOrders && typeof cached.publicParticipantOrders === "object" ? cached.publicParticipantOrders : {};
    this.publicAuthorityOrders = cached?.publicAuthorityOrders && typeof cached.publicAuthorityOrders === "object" ? cached.publicAuthorityOrders : {};
    this.publicTreasureSources = cached?.publicTreasureSources && typeof cached.publicTreasureSources === "object" ? cached.publicTreasureSources : {};
    this.modelUsageEvents = Array.isArray(cached?.modelUsageEvents) ? cached.modelUsageEvents.slice(-30).filter(item => item && typeof item === "object") : [];
    this.modelUsageSequence = Math.max(
      Math.max(0, Math.trunc(Number(cached?.modelUsageSequence || 0))),
      ...this.modelUsageEvents.map(item => Math.max(0, Math.trunc(Number(item.id || 0))))
    );
    this.modelConversationIds.clear();
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
    {
      this.appliedMapDeltaIds.clear();
      this.appliedAuthorityIds.clear();
      this.publicDeltaCountSinceSnapshot = 0;
      this.publicMapOrder = { timestamp: 0, commentId: "" };
      this.publicMapBaselineOrder = { timestamp: 0, commentId: "" };
      this.publicHistoryOrder = { timestamp: 0, commentId: "" };
      this.publicCellOrders = {};
      this.publicCellWriteBases = {};
      this.publicGeneralOrders = {};
      this.publicGeneralRecalls = {};
      this.publicMarketOrders = {};
      this.publicMarketSaleOrders = {};
      this.marketSettledSales.clear();
      this.publicParticipantOrders = {};
      this.publicAuthorityOrders = {};
      this.publicTreasureSources = {};
    }
    if (cached?.world?.gameId === GRID_GAME_ID) {
      this.control = cached.control || null;
      this.world = normalizeWorldState(cached.world);
      bindWorldAuthority(this.world, this.control);
      this.restoreLocalOverlay(cached.localOverlay || null);
      this.restoreDirectCache(cached);
    } else {
      this.control = null;
      this.world = null;
    }
    this.pendingJoin = {
      orientation: this.localPreferences.orientation,
      displayName: String(displayName || account.username || "玩家").slice(0, 40)
    };
    if (this.pendingMigration && this.migrationDraft) {
      this.status = "migrating";
      this.error = null;
      this.notify();
      return this.state();
    }
    let syncError = workDetailError;
    try {
      await this.sync(true);
    } catch (error) {
      this.updateLoadProgress({ phase: "error", error: error?.message || String(error) });
      throw error;
    }
    this.assertSyncActive();
    if (this.pendingMigration) {
      this.status = "migrating";
      this.startPolling();
      this.notify();
      return this.state();
    }
    await this.ensureLocalPlayerContext();
    this.assertSyncActive();
    this.status = this.control && this.world ? (syncError ? "degraded" : "ready") : "needs-initialization";
    this.error = syncError ? (syncError?.message || String(syncError)) : null;
    if (this.migrationProof?.sourceWorkId && previousWorkId && previousWorkId !== this.work.id) {
      this.clearCacheForWork(this.migrationProof.sourceWorkId);
    }
    this.startPolling();
    this.notify();
    return this.state();
  }

  async isGameCardAuthor(card) {
    const accountId = this.account().accountId;
    if (!accountId || card?.companion?.authorAccountId !== accountId) return false;
    try {
      const payload = await this.requestConsole(`/installed-apps/${encodeURIComponent(card.companion.workId)}`, { timeout: 8000 });
      return this.account().accountId === accountId && normalizeWorkDetail(payload, card.companion.workId).authorAccountId === accountId;
    } catch (error) {
      const cached = this.verifiedCachedServer(card);
      if (!cached || this.account().accountId !== accountId) return false;
      this.diagnostic({
        event: "card-author-cache-fallback",
        status: "degraded",
        error: error?.message || String(error),
        workId: card.companion.workId
      });
      return true;
    }
  }

  async exportGameCard(selectedCard = this.card) {
    if (!selectedCard) throw new Error("请先选择一张游戏卡");
    const card = validateGameCard(selectedCard);
    if (!await this.isGameCardAuthor(card)) throw new Error("只有伴生作品作者可以导出包含创作页的完整游戏卡");
    const payload = await this.requestConsole(`/apps/${encodeURIComponent(card.companion.workId)}/model-config/export`, { timeout: 30000 });
    const exported = exportedConfig(payload);
    return createExportedGameCard(card, exported);
  }

  loadWorkProgram(card = this.card, pageDescription = null) {
    const description = String(pageDescription || "");
    const liveProgram = parseProgram(description, GRID_GAME_ID);
    if (liveProgram) {
      this.program = { ...liveProgram, source: "work-description" };
      if (this.work) this.work.description = description;
      if (card) this.card = refreshGameCardProgram(card, description);
      return this.program;
    }
    this.program = programFromGameCard(card) || builtInGridProgram();
    return this.program;
  }

  async refreshWorkProgram() {
    if (!this.work) return null;
    const [payload, pageDescription] = await Promise.all([
      this.requestConsole(`/installed-apps/${encodeURIComponent(this.work.id)}`),
      this.fetchLiveProgramDescription(this.card, this.work.id)
    ]);
    const detail = normalizeWorkDetail(payload, this.work.id);
    if (this.card?.companion?.authorAccountId && detail.authorAccountId !== this.card.companion.authorAccountId) throw new Error("作品作者已变更，请重新获取游戏卡");
    this.work = { ...detail, url: this.work.url };
    return this.loadWorkProgram(this.card, pageDescription);
  }

  async initialize() {
    if (!this.work) throw new Error("请先选择伴生作品");
    if (this.control || this.world) throw new Error("本游戏已经开服");
    if (!isVerifiedProgram(this.program)) throw new Error("游戏卡中尚未包含有效游戏程序包");
    const account = this.account();
    if (!this.work.authorAccountId || account.accountId !== this.work.authorAccountId) throw new Error("只有作品作者可以初始化新赛季");
    const identity = await this.getIdentity();
    const world = createWorld({ authorityAccountId: account.accountId, startedAt: this.now() });
    scatterTreasures(world, {}, this.now());
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
      occupationCountingProtocol: 1,
      startedAt: world.startedAt,
      updatedAt: world.startedAt
    }, identity.signingPrivateKey);
    this.world = world;
    this.clearDirectSession();
    this.publicMapOrder = { timestamp: 0, commentId: "" };
    this.publicMapBaselineOrder = { timestamp: 0, commentId: "" };
    this.publicHistoryOrder = { timestamp: 0, commentId: "" };
    this.publicCellOrders = {};
    this.publicCellWriteBases = {};
    this.publicGeneralOrders = {};
    this.publicGeneralRecalls = {};
    this.localGeneralArchiveOrders = {};
    this.publicMarketOrders = {};
    this.publicMarketSaleOrders = {};
    this.marketSettledSales.clear();
    this.publicParticipantOrders = {};
    this.publicAuthorityOrders = {};
    this.publicTreasureSources = {};
    this.appliedMapDeltaIds.clear();
    this.appliedAuthorityIds.clear();
    const controlSources = await this.postRecord(this.control);
    this.controlPlatformOrder = recordPlatformOrder({ sources: controlSources });
    this.rememberTreasureSources(world.treasureSpawns, this.controlPlatformOrder);
    await this.publishSnapshot();
    this.status = "ready";
    this.saveCache();
    this.notify();
    return this.state();
  }

  async postComment(content, options = {}) {
    if (String(content).length > FYOW_COMMENT_LIMIT) throw new Error(`评论数据超过 ${FYOW_COMMENT_LIMIT} 字符限制`);
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
    const chunks = encodeCommentRecord(record);
    let rootId = String(options.parentId || "");
    let rootAccountId = String(options.toAccountId || this.work?.authorAccountId || "");
    for (let index = 0; index < chunks.length; index += 1) {
      const content = chunks[index];
      const writeOptions = rootId ? { ...options, parentId: rootId, toAccountId: rootAccountId } : options;
      const response = await this.retryPlatformWrite(() => this.postComment(content, writeOptions));
      const source = firstObject(response, item => Boolean(item.id || item.comment_id) && typeof item.content === "string")
        || firstObject(response, item => Boolean(item.id || item.comment_id)) || response || {};
      const timestampSource = firstObject(response, item => commentTimestamp(item) > 0);
      if (typeof source?.content === "string" && source.content !== content) throw new Error("平台返回的评论正文与提交分片不一致");
      if (commentAccountId(source) && commentAccountId(source) !== this.account().accountId) throw new Error("平台返回的评论作者与当前账号不一致");
      const sourceParentId = String(source?.parent_id || source?.parentId || source?.root_comment_id || source?.rootCommentId || "");
      if (sourceParentId && sourceParentId !== String(writeOptions.parentId || "")) throw new Error("平台返回的评论分支与提交分片不一致");
      const normalized = {
        ...(source && typeof source === "object" ? source : {}),
        id: commentId(source) || commentId(response),
        account_id: commentAccountId(source) || commentAccountId(response) || this.account().accountId,
        created_at: source?.created_at ?? source?.createdAt ?? source?.create_time ?? source?.createTime
          ?? source?.published_at ?? source?.publishedAt ?? source?.timestamp
          ?? timestampSource?.created_at ?? timestampSource?.createdAt ?? timestampSource?.create_time ?? timestampSource?.createTime
          ?? timestampSource?.published_at ?? timestampSource?.publishedAt ?? timestampSource?.timestamp
          ?? new Date(this.now()).toISOString(),
        ...(writeOptions.parentId ? { parent_id: String(writeOptions.parentId) } : {}),
        content
      };
      responses.push(normalized);
      if (index === 0 && !rootId) {
        rootId = commentId(normalized);
        rootAccountId = commentAccountId(normalized) || rootAccountId;
        if (chunks.length > 1 && !rootId) throw new Error("平台没有返回分片根评论编号，无法发布原生回复分片");
      }
    }
    return responses;
  }

  async retryPlatformWrite(write, attempts = COMMENT_POST_ATTEMPTS) {
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        return await write();
      } catch (error) {
        lastError = error;
        if (!isTransientPlatformError(error)) throw error;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
    throw lastError;
  }

  async readHistoryPage(page, { fresh = false } = {}) {
    const session = this.commentReadSession;
    if (!session || fresh) return this.fetchHistoryPage(page);
    const key = `${this.work.id}:${page}`;
    if (!session.pages.has(key)) {
      const pending = this.fetchHistoryPage(page).catch(error => {
        session.pages.delete(key);
        throw error;
      });
      session.pages.set(key, pending);
    }
    return session.pages.get(key);
  }

  async fetchHistoryPage(page) {
    this.assertSyncActive();
    const endpoint = `/comments/${encodeURIComponent(this.work.id)}/1?page=${page}&limit=${HISTORY_PAGE_SIZE}&order=created_at_desc&filter_type=all`;
    const payload = await this.readCommentData(endpoint, { page }, 20000);
    this.assertSyncActive();
    const comments = extractCommentItems(payload);
    this.trackReadComments(comments);
    for (const root of commentPageRoots(comments)) this.commentRootPages.set(commentId(root), page);
    if (this.commentRootPages.size > 2000) this.commentRootPages = new Map([...this.commentRootPages].slice(-2000));
    return comments;
  }

  async readCommentData(endpoint, context, timeout = 15000) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const payload = await this.requestConsole(endpoint, { timeout, attempts: 1 });
        const keys = ["data", "items", "list", "rows", "comment", "comments", "results", "records", "result", "payload", "response", "children", "replies", "branches", "child_comments", "sub_comments"];
        const queue = [payload];
        let valid = false;
        for (let index = 0; index < queue.length && index < 64; index += 1) {
          const value = queue[index];
          if (Array.isArray(value) || (value && typeof value.content === "string" && (value.id || value.comment_id))) { valid = true; break; }
          if (value && typeof value === "object") for (const key of keys) if (value[key] && typeof value[key] === "object") queue.push(value[key]);
        }
        if (!valid) throw platformRequestError("PLATFORM_DATA_SHAPE", "平台数据列表格式无效");
        return payload;
      } catch (error) {
        this.assertSyncActive();
        if (!isTransientPlatformError(error) || attempt === 2) throw error;
        this.diagnostic({ event: context.rootCommentId ? "comment-branch-read-retry" : "comment-page-read-retry", ...context, attempt, code: error?.code || null, error: error?.message || String(error) });
        await new Promise(resolve => setTimeout(resolve, 300));
        this.assertSyncActive();
      }
    }
  }

  async probeMigrationReset() {
    try {
      const comments = await this.readHistoryPage(1);
      const assembled = assembleCommentRecords(comments);
      const hydrated = await this.hydrateCommentReplies(comments, {
        ...assembled, incomplete: assembled.incomplete.filter(item => item.kind === "RESET")
      }, new Set());
      return this.verifiedResetsWithoutControl(assembleCommentRecords(hydrated).records)[0] || null;
    } catch (error) {
      if (this.syncPaused) throw error;
      this.diagnostic({ event: "migration-probe-failed", error: error?.message || String(error), workId: this.work?.id || "" });
      return null;
    }
  }

  async readCommentBranches(rootCommentId, maxPages = REPLY_PAGE_LIMIT, options = {}) {
    const session = this.commentReadSession;
    const key = `${this.work?.id || ""}:${rootCommentId}:${maxPages}`;
    if (!session) return this.fetchCommentBranches(rootCommentId, maxPages, options);
    if (!session.branches.has(key)) session.branches.set(key, this.fetchCommentBranches(rootCommentId, maxPages, options));
    return session.branches.get(key);
  }

  async fetchCommentBranches(rootCommentId, maxPages = REPLY_PAGE_LIMIT, options = {}) {
    const rootId = String(rootCommentId || "");
    if (!rootId) return [];
    const result = [];
    const seen = new Set();
    let page = 1;
    while (page <= maxPages) {
      this.assertSyncActive();
      const endpoint = page === 1
        ? `/comments/branches/${encodeURIComponent(rootId)}`
        : `/comments/branches/${encodeURIComponent(rootId)}?page=${page}&limit=${HISTORY_PAGE_SIZE}`;
      let payload;
      try {
        payload = await this.readCommentData(endpoint, { rootCommentId: rootId, page });
        this.assertSyncActive();
      } catch (error) {
        if (this.syncPaused) throw error;
        this.commentReadSession?.failedRoots.set(rootId, error);
        this.diagnostic({
          event: "comment-branch-read-failed", rootCommentId: rootId, page,
          error: error?.message || String(error)
        });
        break;
      }
      const items = extractCommentItems(payload);
      const beforeCount = seen.size;
      for (const item of items) {
        const id = commentId(item);
        if (id && !seen.has(id)) {
          seen.add(id);
          result.push({ ...item, _fyowRootId: rootId });
        }
      }
      const meta = firstObject(payload, item => item && typeof item === "object"
        && (Object.hasOwn(item, "has_more") || Object.hasOwn(item, "hasMore") || Object.hasOwn(item, "next_page")
          || Object.hasOwn(item, "nextPage") || Object.hasOwn(item, "total_pages") || Object.hasOwn(item, "totalPages")));
      const hasMore = meta
        ? Boolean((meta.has_more ?? meta.hasMore ?? meta.next_page ?? meta.nextPage)
          || Number(meta.total_pages ?? meta.totalPages ?? 0) > page)
        : commentPageRootCount(items) >= HISTORY_PAGE_SIZE;
      if (!hasMore || !commentPageRootCount(items) || seen.size === beforeCount) break;
      if (page === maxPages) this.commentReadSession?.failedRoots.set(rootId, new Error("评论回复分页超过读取上限，请重试同步"));
      page += 1;
    }
    const expectedRoot = options.rootComment;
    const expectedChunk = decodeCommentChunk(expectedRoot?.content);
    const missingExpectedRecord = expectedChunk && !assembleCommentRecords([expectedRoot, ...result]).records.some(item => item.id === expectedChunk.id && item.kind === expectedChunk.kind);
    // The live platform can return an empty branches endpoint while delivering
    // native replies in the root's children on the main comment list.
    if (this.work?.id && (!result.length || missingExpectedRecord)) {
      const hintedPage = this.commentRootPages.get(rootId)
        || (this.historyPageOrder === "newest-first" ? 1 : Math.max(1, Number(this.historyTailPage || 1)));
      const candidates = [...new Set([hintedPage, hintedPage + 1, hintedPage - 1])].filter(candidate => candidate >= 1 && candidate <= MAX_HISTORY_PAGES);
      for (const candidate of candidates) {
        let comments;
        try {
          comments = await this.readHistoryPage(candidate);
        } catch (error) {
          if (this.syncPaused) throw error;
          this.diagnostic({ event: "comment-root-read-failed", rootCommentId: rootId, page: candidate, error: error?.message || String(error) });
          continue;
        }
        const root = comments.find(item => commentId(item) === rootId);
        if (!root) continue;
        for (const item of comments) {
          const id = commentId(item);
          if (!id || id === rootId || String(item._fyowRootId || "") !== rootId || seen.has(id)) continue;
          seen.add(id);
          result.push(item);
        }
        break;
      }
    }
    this.trackReadComments(result);
    return result;
  }

  async hydrateCommentReplies(comments, assembled = null, fetchedRoots = new Set()) {
    const base = extractCommentItems(Array.isArray(comments) ? comments : []);
    const current = assembled && base.length === comments?.length ? assembled : assembleCommentRecords(base);
    const roots = [];
    const seenRoots = new Set();
    for (const item of current.incomplete || []) {
      for (const source of item.sources || []) {
        const chunk = decodeCommentChunk(source?.content);
        if (chunk?.part !== 1) continue;
        const id = commentId(source);
        if (id && !seenRoots.has(id) && !fetchedRoots.has(id)) {
          seenRoots.add(id);
          roots.push(id);
        }
      }
    }
    const expanded = [...base];
    const seen = new Set(base.map(commentId).filter(Boolean));
    let cursor = 0;
    const rootById = new Map(base.map(comment => [commentId(comment), comment]));
    const repliesByRoot = new Map();
    await completeReadBatch(Array.from({ length: Math.min(4, roots.length) }, async () => {
      while (cursor < roots.length) {
        const rootId = roots[cursor++];
        fetchedRoots.add(rootId);
        repliesByRoot.set(rootId, await this.readCommentBranches(rootId, REPLY_PAGE_LIMIT, { rootComment: rootById.get(rootId) }));
      }
    }));
    for (const rootId of roots) {
      const replies = repliesByRoot.get(rootId) || [];
      for (const reply of replies) {
        const id = commentId(reply);
        if (id && !seen.has(id)) {
          seen.add(id);
          expanded.push(reply);
        }
      }
    }
    return expanded;
  }

  async locateHistoryTailPage(readPage) {
    const hintedPage = Math.max(1, Math.trunc(Number(this.historyTailPage || 1)));
    const hinted = await readPage(hintedPage);
    if (!commentPageRootCount(hinted) && hintedPage > 1) {
      this.historyTailPage = 1;
      return this.locateHistoryTailPage(readPage);
    }
    if (commentPageRootCount(hinted) < HISTORY_PAGE_SIZE) return hintedPage;
    let lower = hintedPage;
    let upper = null;
    let step = 1;
    while (lower < MAX_HISTORY_PAGES) {
      const candidate = Math.min(MAX_HISTORY_PAGES, hintedPage + step);
      const comments = await readPage(candidate);
      if (!commentPageRootCount(comments)) {
        upper = candidate;
        break;
      }
      lower = candidate;
      if (commentPageRootCount(comments) < HISTORY_PAGE_SIZE || candidate === MAX_HISTORY_PAGES) return candidate;
      step *= 2;
    }
    if (upper == null) return lower;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const comments = await readPage(middle);
      if (!commentPageRootCount(comments)) upper = middle;
      else {
        lower = middle;
        if (commentPageRootCount(comments) < HISTORY_PAGE_SIZE) return middle;
      }
    }
    return lower;
  }

  // Target-ledger verification must enumerate every platform page because a
  // newly created work has no trusted snapshot coverage until it is verified.
  async readAllCommentSources({ includeAllBranches = false } = {}) {
    const comments = [];
    const seen = new Set();
    const fetchedRoots = new Set();
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const items = await this.readHistoryPage(page);
      const rootCount = commentPageRootCount(items);
      for (const item of items) {
        const id = commentId(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        comments.push(item);
      }
      if (!rootCount || rootCount < HISTORY_PAGE_SIZE) break;
    }
    let hydrated;
    if (includeAllBranches) {
      hydrated = [...comments];
      for (const root of commentPageRoots(comments)) {
        const rootId = commentId(root);
        if (!rootId || fetchedRoots.has(rootId)) continue;
        fetchedRoots.add(rootId);
        const replies = await this.readCommentBranches(rootId, REPLY_PAGE_LIMIT, { rootComment: root });
        hydrated.push(...replies);
      }
    } else {
      hydrated = await this.hydrateCommentReplies(comments, assembleCommentRecords(comments), fetchedRoots);
    }
    for (const item of hydrated) {
      const id = commentId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      comments.push(item);
    }
    return comments;
  }

  async readHistory(fullScan) {
    const all = [];
    const seen = new Set();
    const pages = new Map();
    const fetchedRoots = new Set();
    const pendingRewards = this.pendingTreasureRewards();
    const confirmationFloor = pendingRewards.length
      ? pendingRewards.map(([, reward]) => reward.scanFrom || { timestamp: 0, commentId: "" }).sort(compareOrderValue)[0] : null;
    let confirmationComplete = !confirmationFloor;
    let stoppedBy = null;
    let reachedCoverage = false;
    let pagesRead = 0;
    const readPage = async page => {
      if (pages.has(page)) return pages.get(page);
      const comments = await this.readHistoryPage(page);
      pages.set(page, comments);
      pagesRead += 1;
      return comments;
    };
    const tailPage = await this.locateHistoryTailPage(readPage);
    this.historyTailPage = tailPage;
    const firstPageComments = await readPage(1);
    const tailPageComments = tailPage === 1 ? firstPageComments : await readPage(tailPage);
    if (this.commentReadSession) {
      this.commentReadSession.totalRoots = (tailPage - 1) * HISTORY_PAGE_SIZE + commentPageRootCount(tailPageComments);
      this.trackReadComments([]);
    }
    const timestamps = comments => commentPageRoots(comments).map(commentTimestamp).filter(Boolean);
    const monotonic = (values, ascending) => values.every((value, index) => !index || (ascending ? values[index - 1] <= value : values[index - 1] >= value));
    const firstTimes = timestamps(firstPageComments);
    const tailTimes = timestamps(tailPageComments);
    // Pinned comments or platform changes can still break chronology.
    // A snapshot is only an early-stop boundary when page chronology is proven.
    const oldestFirst = tailPage > 1 && firstTimes.length && tailTimes.length
      && monotonic(firstTimes, true) && monotonic(tailTimes, true)
      && Math.max(...firstTimes) <= Math.min(...tailTimes);
    const newestFirst = tailPage > 1 && firstTimes.length && tailTimes.length
      && monotonic(firstTimes, false) && monotonic(tailTimes, false)
      && Math.min(...firstTimes) >= Math.max(...tailTimes);
    const pageOrder = tailPage === 1 ? "newest-first" : oldestFirst ? "oldest-first" : newestFirst ? "newest-first" : "mixed";
    this.historyPageOrder = pageOrder;
    const scanPages = pageOrder === "newest-first"
      ? Array.from({ length: tailPage }, (_, index) => index + 1)
      : Array.from({ length: tailPage }, (_, index) => tailPage - index);
    if (fullScan || pageOrder === "mixed") {
      for (let index = 0; index < scanPages.length; index += 4) {
        await completeReadBatch(scanPages.slice(index, index + 4).map(readPage));
      }
    }
    for (const page of scanPages) {
      const comments = await readPage(page);
      for (const comment of comments) {
        const id = commentId(comment);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(comment);
      }
      if (fullScan || pageOrder === "mixed") continue;
      const expanded = await this.hydrateCommentReplies(all, assembleCommentRecords(all), fetchedRoots);
      for (const comment of expanded) {
        const id = commentId(comment);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(comment);
      }
      if (pageOrder === "mixed") continue;
      const assembled = assembleCommentRecords(all);
      if (confirmationFloor) {
        confirmationComplete = !assembled.incomplete.length && commentPageRoots(comments).some(comment => commentTimestamp(comment) > 0 && compareOrderValue(
          { timestamp: commentTimestamp(comment), commentId: commentId(comment) }, confirmationFloor
        ) <= 0);
      }
      const decision = historyPageDecision({
        pageComments: comments,
        assembled,
        knownCommentIds: [...this.knownCommentIds],
        fullScan,
        requireControl: Boolean(fullScan || !this.control)
      });
      const historyControl = this.verifiedControls(assembled.records)[0]?.record || this.control;
      const newestSnapshot = this.verifiedSnapshots(assembled.records, historyControl)[0];
      const replacingSnapshot = newestSnapshot && (!this.world || compareOrderValue(recordPlatformOrder(newestSnapshot), this.publicMapOrder) > 0);
      const floor = replacingSnapshot
        ? ledgerOrder(snapshotCoverage(newestSnapshot.record)?.through)
        : ledgerOrder(this.publicHistoryOrder);
      const reachedFloor = floor.timestamp > 0 && commentPageRoots(comments).some(comment =>
        commentTimestamp(comment) > 0 && compareOrderValue({ timestamp: commentTimestamp(comment), commentId: commentId(comment) }, floor) <= 0);
      if (decision.stop && reachedFloor && (!confirmationFloor || confirmationComplete)) {
        stoppedBy = decision.reason;
        reachedCoverage = true;
        break;
      }
    }
    if (pageOrder === "mixed") stoppedBy = "mixed-page-order-full-scan";
    const hydrated = await this.hydrateCommentReplies(all, assembleCommentRecords(all), fetchedRoots);
    const assembled = assembleCommentRecords(hydrated);
    const hitHistoryCap = tailPage === MAX_HISTORY_PAGES && commentPageRootCount(tailPageComments) >= HISTORY_PAGE_SIZE;
    if (hitHistoryCap) throw new Error("评论分页尚未读取完整，请重试同步");
    for (const partial of assembled.incomplete) {
      for (const source of partial.sources || []) {
        const error = this.commentReadSession?.failedRoots.get(commentId(source));
        if (error) throw new Error(`评论分片读取中断，请重试同步：${error.message}`);
      }
    }
    if (this.loadProgress?.active) {
      this.updateLoadProgress({ phase: "validating", pendingRecords: assembled.incomplete.length });
      // Verify the cloud page boundaries before using this entry snapshot.
      // A concurrent insert or deletion must trigger another full read.
      const signature = items => canonicalJson(items.map(item => [commentId(item), String(item.content || "")]).sort((a, b) => a[0].localeCompare(b[0])));
      for (let start = 1; start <= tailPage; start += 4) {
        const pageNumbers = Array.from({ length: Math.min(4, tailPage - start + 1) }, (_, offset) => start + offset);
        const checked = await completeReadBatch(pageNumbers.map(async page => ({ page, comments: await this.readHistoryPage(page, { fresh: true }) })));
        if (checked.some(({ page, comments }) => signature(comments) !== signature(pages.get(page) || []))) {
          const error = new Error("云端评论在读取期间发生变化，正在重新读取");
          error.code = "FYOW_HISTORY_CHANGED";
          throw error;
        }
      }
      if (commentPageRootCount(tailPageComments) === HISTORY_PAGE_SIZE
        && commentPageRootCount(await this.readHistoryPage(tailPage + 1, { fresh: true }))) {
        const error = new Error("云端评论分页在读取期间增加，正在重新读取");
        error.code = "FYOW_HISTORY_CHANGED";
        throw error;
      }
      this.updateLoadProgress({ phase: "validating" });
    }
    if ((!stoppedBy || pageOrder === "mixed") && !hitHistoryCap) reachedCoverage = true;
    const newestRootTime = commentPageRoots(hydrated).reduce((maximum, comment) => Math.max(maximum, commentTimestamp(comment)), 0);
    let completeThrough = { timestamp: Math.max(0, newestRootTime - 1), commentId: "" };
    for (const partial of assembled.incomplete) {
      const root = (partial.sources || []).find(source => decodeCommentChunk(source.content)?.part === 1);
      const beforePartial = { timestamp: Math.max(0, commentTimestamp(root) - 1), commentId: "" };
      if (compareOrderValue(beforePartial, completeThrough) < 0) completeThrough = beforePartial;
    }
    if (confirmationFloor && !stoppedBy && !assembled.incomplete.length) confirmationComplete = true;
    if (confirmationFloor && pageOrder === "mixed" && !assembled.incomplete.length) confirmationComplete = true;
    this.history = { pagesRead, commentsRead: hydrated.length, stoppedBy: stoppedBy || "oldest-page", incomplete: assembled.incomplete.length, invalid: assembled.invalid.length, tailPage, pageOrder };
    const newestComments = [...hydrated]
      .sort((left, right) => commentTimestamp(left) - commentTimestamp(right) || commentId(left).localeCompare(commentId(right)))
      .slice(-500);
    for (const comment of newestComments) this.knownCommentIds.add(commentId(comment));
    if (this.knownCommentIds.size > 500) this.knownCommentIds = new Set([...this.knownCommentIds].slice(-500));
    return { comments: hydrated, assembled, pages, tailPage, pageOrder, confirmationComplete, completeThrough: reachedCoverage ? completeThrough : null };
  }

  verifiedControls(records) {
    return (records || [])
      .filter(item => item.record?.schema === FYOW_SCHEMAS.control && item.record.workId === this.work?.id && item.record.gameId === GRID_GAME_ID && this.validAuthorSource(item))
      .filter(item => String(item.record.authorityAccountId || "") === this.work?.authorAccountId)
      .filter(item => verifySignedRecord(item.record, item.record.authoritySigningPublicKey))
      .sort((left, right) => comparePlatformOrder(right, left));
  }

  verifiedSnapshots(records, control = this.control) {
    if (!control) return [];
    return (records || [])
      .filter(item => item.record?.schema === FYOW_SCHEMAS.snapshot && item.record.seasonId === control.seasonId && item.record.workId === this.work?.id && item.record.gameId === GRID_GAME_ID)
      .filter(item => this.validAuthorSource(item) && recordPlatformOrder(item).timestamp > 0)
      .filter(item => verifySignedRecord(item.record, control.authoritySigningPublicKey))
      .filter(item => item.record.stateHash === sha256(Buffer.from(canonicalJson(item.record.state))))
      .filter(item => validSnapshotOccupationCounts(item.record.state))
      .filter(item => !item.record.ledgerCoverage || (snapshotCoverage(item.record) && compareOrderValue(ledgerOrder(snapshotCoverage(item.record).through), recordPlatformOrder(item)) <= 0))
      .sort((left, right) => comparePlatformOrder(right, left));
  }

  verifiedResets(records, control = this.control) {
    if (!control) return [];
    return (records || [])
      .filter(item => item.record?.schema === FYOW_SCHEMAS.reset
        && item.record.gameId === GRID_GAME_ID
        && item.record.seasonId === control.seasonId
        && item.record.oldWorkId === this.work?.id
        && item.record.newWorkId
        && item.record.newWorkId !== this.work?.id)
      .filter(item => this.validAuthorSource(item)
        && (!item.record.authorityAccountId || String(item.record.authorityAccountId) === String(control.authorityAccountId))
        && (!item.record.authoritySigningPublicKey || String(item.record.authoritySigningPublicKey) === String(control.authoritySigningPublicKey))
        && verifySignedRecord(item.record, control.authoritySigningPublicKey))
      .sort((left, right) => Number(right.record.issuedAt || 0) - Number(left.record.issuedAt || 0)
        || comparePlatformOrder(right, left));
  }

  verifiedResetsWithoutControl(records) {
    return (records || [])
      .filter(item => item.record?.schema === FYOW_SCHEMAS.reset
        && item.record.gameId === GRID_GAME_ID
        && item.record.oldWorkId === this.work?.id
        && item.record.newWorkId
        && item.record.newWorkId !== this.work?.id
        && String(item.record.authorityAccountId || "") === String(this.work?.authorAccountId || "")
        && String(item.record.authoritySigningPublicKey || ""))
      .filter(item => this.validAuthorSource(item) && verifySignedRecord(item.record, item.record.authoritySigningPublicKey))
      .sort((left, right) => Number(right.record.issuedAt || 0) - Number(left.record.issuedAt || 0)
        || comparePlatformOrder(right, left));
  }

  migrationStateFromReset(item, extra = {}) {
    const record = item?.record || {};
    return {
      workId: String(record.newWorkId || ""),
      url: String(record.newWorkUrl || ""),
      issuedAt: Number(record.issuedAt || 0),
      migrationId: String(record.migrationId || record.resetId || ""),
      resetId: String(record.resetId || ""),
      sourceWorkId: String(record.oldWorkId || this.work?.id || ""),
      seasonId: String(record.seasonId || ""),
      sourceControlId: String(record.sourceControlId || ""),
      sourceProgramHash: String(record.sourceProgramHash || ""),
      authorityAccountId: String(record.authorityAccountId || ""),
      authoritySigningPublicKey: String(record.authoritySigningPublicKey || ""),
      targetControlId: String(record.targetControlId || ""),
      targetProgramHash: String(record.targetProgramHash || ""),
      targetSnapshotId: String(record.targetSnapshotId || ""),
      exportSha256: String(record.exportSha256 || ""),
      ...extra
    };
  }

  migrationStateFromDetectedReset(item) {
    return this.migrationStateFromReset(item);
  }

  validAuthorSource(item) {
    const sources = item.sources || [];
    return sources.length > 0 && sources.every(source => {
      const accountId = commentAccountId(source);
      return accountId ? accountId === this.work.authorAccountId : commentIsFromAuthor(source);
    });
  }

  rememberTreasureSources(spawns, order = { timestamp: 0, commentId: "" }, retiringEpoch = null) {
    if (retiringEpoch != null) {
      for (const source of Object.values(this.publicTreasureSources)) {
        if (Number(source.spawn?.epoch) >= retiringEpoch) continue;
        if (!source.retiredOrder || compareOrderValue(order, source.retiredOrder) < 0) source.retiredOrder = { ...order };
      }
    }
    for (const [id, spawn] of Object.entries(spawns || {})) {
      if (!spawn || !MATERIAL_BY_ID[String(spawn.materialId || "")]) continue;
      const existing = this.publicTreasureSources[id];
      if (!existing) this.publicTreasureSources[id] = { spawn: cloneJson(spawn), introducedOrder: { ...order } };
    }
  }

  collectTreasureSources(records) {
    const snapshots = this.verifiedSnapshots(records);
    const scatters = (records || []).filter(item => item.record?.type === "treasure-scatter" && this.validAuthorityDirective(item));
    for (const item of [...snapshots, ...scatters].sort(comparePlatformOrder)) {
      if (item.record.schema === FYOW_SCHEMAS.snapshot) {
        this.rememberTreasureSources(item.record.state?.treasureSpawns, recordPlatformOrder(item));
      } else this.rememberTreasureSources(item.record.treasureSpawns, recordPlatformOrder(item), item.record.treasureEpoch);
    }
  }

  validMapDelta(item) {
    const record = item?.record;
    if (record?.schema !== FYOW_SCHEMAS.mapDelta || record.seasonId !== this.control?.seasonId || record.workId !== this.work?.id || record.gameId !== GRID_GAME_ID) return false;
    const actorAccountId = String(record.actorAccountId || "");
    if (!actorAccountId || !record.deviceSigningPublicKey || !verifySignedRecord(record, record.deviceSigningPublicKey)) return false;
    const order = recordPlatformOrder(item);
    if (!(item.sources || []).length || !(item.sources || []).every(source => commentAccountId(source) === actorAccountId) || !order.timestamp) return false;
    const currentEpoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[actorAccountId] || 0)));
    if (Math.max(0, Math.trunc(Number(record.playerEpoch || 0))) !== currentEpoch) return false;
    if (this.world?.bans?.[actorAccountId]?.banned) return false;
    const cells = record.changes?.cells;
    const cellBases = record.changes?.cellBases;
    const allowLegacyOccupation = cellBases == null;
    const generals = record.changes?.generals;
    const hasGeneralTransitionEnvelope = Object.hasOwn(record.changes || {}, "generalTransitions");
    const generalTransitions = record.changes?.generalTransitions || {};
    const marketListings = record.changes?.marketListings || {};
    const marketSales = record.changes?.marketSales || {};
    const treasureClaims = record.changes?.claimedTreasures || {};
    const battles = record.changes?.battles || {};
    const conquests = record.changes?.conquests || {};
    if (!cells || typeof cells !== "object" || Array.isArray(cells) || !generals || typeof generals !== "object" || Array.isArray(generals)) return false;
    if (cellBases != null && (typeof cellBases !== "object" || Array.isArray(cellBases))) return false;
    if (!allowLegacyOccupation) {
      if (!cellBases || Object.keys(cellBases).length !== Object.keys(cells).length
        || Object.keys(cells).some(key => !Object.hasOwn(cellBases, key))) return false;
    }
    for (const [key, base] of Object.entries(cellBases || {})) {
      if (!Object.hasOwn(cells, key) || !base || typeof base !== "object" || Array.isArray(base)) return false;
      const envelope = occupationEnvelope(record.changes, key);
      if (!envelope.modern || (envelope.baseCell != null && !isPublicCellShape(envelope.baseCell))) return false;
      if (!Number.isSafeInteger(base.nextOccupationCount) || base.nextOccupationCount < 0 || base.nextOccupationCount > MAX_OCCUPATION_COUNT) return false;
      if (!base.order || !Number.isSafeInteger(base.order.timestamp) || base.order.timestamp < 0
        || typeof base.order.commentId !== "string" || compareOrderValue(envelope.baseOrder, order) >= 0) return false;
    }
    if (!generalTransitions || typeof generalTransitions !== "object" || Array.isArray(generalTransitions) || Object.keys(generalTransitions).length > 100) return false;
    if (!treasureClaims || typeof treasureClaims !== "object" || Array.isArray(treasureClaims) || Object.keys(treasureClaims).length > 24) return false;
    if (!marketListings || typeof marketListings !== "object" || Array.isArray(marketListings) || Object.keys(marketListings).length > 100) return false;
    if (!marketSales || typeof marketSales !== "object" || Array.isArray(marketSales) || Object.keys(marketSales).length > 100) return false;
    if (!battles || typeof battles !== "object" || Array.isArray(battles) || Object.keys(battles).length > 24) return false;
    if (!conquests || typeof conquests !== "object" || Array.isArray(conquests) || Object.keys(conquests).length > 24) return false;
    for (const [id, battle] of Object.entries(conquests)) {
      if (!battle || typeof battle !== "object" || String(battle.battleId || "") !== id || id.length > 100
        || battle.attackerAccountId !== actorAccountId || !battle.targetOwnerAccountId || battle.targetOwnerAccountId === actorAccountId
        || !validPosition(battle) || !Number.isSafeInteger(battle.createdAt) || battle.createdAt < 0
        || !Number.isSafeInteger(battle.targetPlayerEpoch) || battle.targetPlayerEpoch < 0) return false;
      const locationKey = `${battle.x},${battle.y}`;
      const envelope = occupationEnvelope(record.changes, locationKey);
      const next = envelope.modern ? envelope.nextCell : cells[locationKey];
      const current = !allowLegacyOccupation && envelope.modern ? envelope.baseCell : this.world?.cells?.[locationKey];
      if (!isPublicCellShape(next) || next.ownerAccountId !== actorAccountId || next.generalIds?.length) return false;
      if (!allowLegacyOccupation && (!current
        || String(current.ownerAccountId || "") !== String(battle.targetOwnerAccountId || "")
        || Number(current.soldiers || 0) !== Number(battle.defenderSoldiers || 0)
        || Number(this.world?.playerEpochs?.[battle.targetOwnerAccountId] || 0) !== Number(battle.targetPlayerEpoch || 0))) return false;
      const fields = ["attackerSoldiers", "defenderSoldiers", "attackerLosses", "defenderLosses", "attackerSurvivors", "defenderSurvivors"];
      if (fields.some(field => safeBattleInteger(battle[field]) == null)
        || ["attackerPower", "defenderPower"].some(field => safeBattleInteger(battle[field], MAX_PUBLIC_BATTLE_POWER, 1) == null)) return false;
      const expected = battleCasualties(battle.attackerPower, battle.defenderPower, battle.attackerSoldiers, battle.defenderSoldiers);
      if (!expected.attackerWon || ["attackerLosses", "defenderLosses", "attackerSurvivors", "defenderSurvivors"].some(field => battle[field] !== expected[field])
        || next.soldiers !== Math.min(cellGarrisonCap(this.world, battle.x, battle.y, next), expected.attackerSurvivors)) return false;
      if (!Array.isArray(battle.capturedOwnGenerals) || battle.capturedOwnGenerals.length > 2
        || new Set(battle.capturedOwnGenerals.map(item => item?.id)).size !== battle.capturedOwnGenerals.length) return false;
      for (const general of battle.capturedOwnGenerals) {
        const transition = generalTransitions[general?.id];
        if (!validGeneralTransitionShape(general?.id, transition) || transition.reason !== "captured"
          || transition.holderAccountId !== battle.targetOwnerAccountId || transition.nextHolderAccountId !== actorAccountId
          || transition.from.x !== battle.x || transition.from.y !== battle.y
          || typeof general.name !== "string" || general.name.length > 24) return false;
      }
      if (String(battle.attackerDisplayName || "").length > 40 || String(battle.attackerAccountName || "").length > 80) return false;
    }
    if (Object.hasOwn(record.changes, "treasureSpawns") || Object.hasOwn(record.changes, "treasureEpoch")) return false;
    if (Object.keys(cells).length > GRID_SIZE * GRID_SIZE || Object.keys(generals).length > 100) return false;
    const battleCellKeys = new Set();
    for (const [battleId, battle] of Object.entries(battles)) {
      if (!battle || typeof battle !== "object" || Array.isArray(battle) || String(battle.battleId || "") !== battleId) return false;
      if (String(battle.attackerAccountId || "") !== actorAccountId || String(battle.outcome || "") !== "attacker-lost") return false;
      const x = Number(battle.x);
      const y = Number(battle.y);
      if (!Number.isInteger(x) || x < 0 || x >= GRID_SIZE || !Number.isInteger(y) || y < 0 || y >= GRID_SIZE) return false;
      const key = `${x},${y}`;
      if (battleCellKeys.has(key) || !Object.hasOwn(cells, key) || cells[key] == null) return false;
      battleCellKeys.add(key);
      const envelope = occupationEnvelope(record.changes, key);
      const current = !allowLegacyOccupation && envelope.modern ? envelope.baseCell : this.world?.cells?.[key];
      if (!current || String(current.ownerAccountId || "") !== String(battle.targetOwnerAccountId || "") || String(current.ownerAccountId || "") === actorAccountId) return false;
      const beforeSoldiers = safeBattleInteger(battle.beforeSoldiers);
      const afterSoldiers = safeBattleInteger(battle.afterSoldiers);
      const currentSoldiers = safeBattleInteger(current.soldiers);
      if (beforeSoldiers == null || afterSoldiers == null || currentSoldiers == null
        || beforeSoldiers !== currentSoldiers || afterSoldiers >= beforeSoldiers) return false;
      const next = envelope.modern ? envelope.nextCell : cells[key];
      if (!isPublicCellShape(next)
        || String(next.ownerAccountId || "") !== String(current.ownerAccountId || "")
        || canonicalJson(next.generalIds || []) !== canonicalJson(current.generalIds || [])
        || safeBattleInteger(next.soldiers) !== afterSoldiers) return false;
      const attackerSoldiers = safeBattleInteger(battle.attackerSoldiers);
      const defenderSoldiers = safeBattleInteger(battle.defenderSoldiers);
      const attackerPower = safeBattleInteger(battle.attackerPower, MAX_PUBLIC_BATTLE_POWER, 1);
      const defenderPower = safeBattleInteger(battle.defenderPower, MAX_PUBLIC_BATTLE_POWER, 1);
      const attackerLosses = safeBattleInteger(battle.attackerLosses);
      const defenderLosses = safeBattleInteger(battle.defenderLosses);
      const attackerSurvivors = safeBattleInteger(battle.attackerSurvivors);
      const defenderSurvivors = safeBattleInteger(battle.defenderSurvivors);
      if ([attackerSoldiers, defenderSoldiers, attackerPower, defenderPower, attackerLosses, defenderLosses, attackerSurvivors, defenderSurvivors].some(value => value == null)) return false;
      if (defenderSoldiers !== beforeSoldiers || attackerSoldiers < 1) return false;
      const expected = battleCasualties(attackerPower, defenderPower, attackerSoldiers, defenderSoldiers);
      if (expected.attackerWon
        || attackerLosses !== expected.attackerLosses
        || defenderLosses !== expected.defenderLosses
        || attackerSurvivors !== expected.attackerSurvivors
        || defenderSurvivors !== expected.defenderSurvivors
        || afterSoldiers !== expected.defenderSurvivors) return false;
    }
    for (const [key, cell] of Object.entries(cells)) {
      const match = key.match(/^(\d+),(\d+)$/);
      if (!match) return false;
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
      const currentCell = this.world?.cells?.[key];
      const envelope = occupationEnvelope(record.changes, key);
      const tracked = envelope.modern;
      const requireBase = tracked;
      const baseCell = requireBase ? envelope.baseCell : currentCell;
      const nextCell = effectivePublicCell(record.changes, key, currentCell);
      if (requireBase) {
        const currentOrder = ledgerOrder(this.publicCellOrders[key] || this.publicMapBaselineOrder);
        const orderFromBase = compareOrderValue(currentOrder, envelope.baseOrder);
        if (orderFromBase < 0 || (orderFromBase === 0 && !samePublicCell(currentCell, baseCell))) return false;
        if (orderFromBase > 0) {
          const expectedBase = occupationBaseDescriptor(envelope);
          const currentBase = this.publicCellWriteBases[key];
          if (!currentBase || compareOrderValue(currentBase.order, expectedBase.order) !== 0
            || String(currentBase.hash || "") !== expectedBase.hash) return false;
        }
      }
      if (cell == null) {
        if (currentCell?.ownerAccountId !== actorAccountId || (requireBase && !samePublicCell(currentCell, baseCell))) return false;
        continue;
      }
      if (!isPublicCellShape(cell) || !isPublicCellShape(nextCell)) return false;
      if (!validOccupationTransition(currentCell, tracked ? nextCell : cell, {
        allowLegacy: allowLegacyOccupation,
        baseCell,
        requireBase
      })) return false;
      const currentOwner = String(baseCell?.ownerAccountId || "");
      const nextOwner = String(nextCell.ownerAccountId || "");
      if (requireBase && currentOwner && currentOwner !== actorAccountId && nextOwner === actorAccountId) {
        const conquest = Object.values(conquests).find(battle => Number(battle?.x) === x && Number(battle?.y) === y);
        if (!conquest) return false;
      }
      if (String(nextCell.ownerAccountId || "") !== actorAccountId && !battleCellKeys.has(key)) return false;
      const submittedSoldiers = Number(nextCell.soldiers);
      const currentSoldiers = Number(baseCell?.soldiers);
      const sameOwner = baseCell
        && String(baseCell.ownerAccountId || "") === String(nextCell.ownerAccountId || "");
      const garrisonCeiling = sameOwner && Number.isSafeInteger(currentSoldiers) && currentSoldiers >= 0
        ? Math.max(cellGarrisonCap(this.world, x, y, nextCell), currentSoldiers)
        : cellGarrisonCap(this.world, x, y, nextCell);
      if (!Number.isSafeInteger(submittedSoldiers) || submittedSoldiers < 0 || submittedSoldiers > garrisonCeiling) return false;
      if (!Array.isArray(nextCell.generalIds) || nextCell.generalIds.length > 2 || new Set(nextCell.generalIds.map(String)).size !== nextCell.generalIds.length) return false;
      if (tracked && compareOrderValue(order, this.publicCellOrders[key] || this.publicMapBaselineOrder) > 0) {
        for (const id of baseCell?.generalIds || []) {
          if (!nextCell.generalIds.includes(id) && (generals[id] !== null || !validGeneralTransitionShape(id, generalTransitions[id]))) return false;
        }
      }
    }
    for (const [id, general] of Object.entries(generals)) {
      if (general == null) continue;
      if (general.status !== "deployed" || general.id !== id || !general.location || String(general.holderAccountId || "") !== actorAccountId) return false;
      if (JSON.stringify(general).length > 30000 || String(general.appearanceSetting || "").length > 350 || String(general.coreSetting || general.setting || "").length > MAX_GENERAL_CORE_SETTING_LENGTH || String(general.memoryText || "").length > 1000) return false;
      if (Array.isArray(general.interactionHistory) && general.interactionHistory.length > 1000) return false;
      if (Array.isArray(general.masterHistory) && general.masterHistory.length > 20) return false;
      if (Array.isArray(general.captivityHistory) && general.captivityHistory.length > 20) return false;
      const x = Number(general.location.x);
      const y = Number(general.location.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
      if (!allowLegacyOccupation && compareOrderValue(order, this.publicGeneralOrders[id] || this.publicMapBaselineOrder) > 0) {
        const key = `${x},${y}`;
        const nextCell = Object.hasOwn(cells, key) ? cells[key] : this.world.cells[key];
        if (nextCell?.ownerAccountId !== actorAccountId || !nextCell.generalIds?.includes(id)) return false;
      }
    }
    if (hasGeneralTransitionEnvelope && Object.entries(generals).some(([id, general]) => general === null && !generalTransitions[id])) return false;
    for (const [id, transition] of Object.entries(generalTransitions)) {
      if (!validGeneralTransitionShape(id, transition) || generals[id] !== null) return false;
      const fromKey = `${transition.from.x},${transition.from.y}`;
      const nextCell = cells[fromKey];
      if (!isPublicCellShape(nextCell) || (nextCell.generalIds || []).map(String).includes(String(id))) return false;
      const currentGeneral = this.world?.generals?.[id];
      if (currentGeneral?.status === "deployed"
        && (Number(currentGeneral.location?.x) !== Number(transition.from.x)
          || Number(currentGeneral.location?.y) !== Number(transition.from.y)
          || String(currentGeneral.holderAccountId || "") !== String(transition.holderAccountId || ""))) return false;
      if (transition.reason === "recalled"
        && (actorAccountId !== String(transition.holderAccountId) || String(nextCell.ownerAccountId || "") !== actorAccountId)) return false;
      if (transition.reason === "captured"
        && (actorAccountId !== String(transition.nextHolderAccountId) || String(nextCell.ownerAccountId || "") !== actorAccountId)) return false;
    }
    for (const [listingId, listing] of Object.entries(marketListings)) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(listingId))) return false;
      const previous = this.world?.marketListings?.[listingId];
      if (listing == null) {
        const sale = Object.values(marketSales).find(item => item && String(item.listingId) === listingId);
        if (String(previous?.sellerAccountId || "") !== actorAccountId && String(sale?.buyerAccountId || "") !== actorAccountId) return false;
        continue;
      }
      if (String(listing.listingId || "") !== listingId || String(listing.sellerAccountId || "") !== actorAccountId) return false;
      const price = Number(listing.price);
      if (!Number.isSafeInteger(price) || price < 1 || price > 1000000000) return false;
      if (Object.hasOwn(listing, "sellerIntro") && (typeof listing.sellerIntro !== "string" || listing.sellerIntro.length > 240)) return false;
      const general = listing.general;
      if (!general || typeof general !== "object" || Array.isArray(general) || String(general.id || "") !== String(listing.generalId || "")) return false;
      if (JSON.stringify(listing).length > 80000 || String(general.coreSetting || general.setting || "").length > MAX_GENERAL_CORE_SETTING_LENGTH) return false;
      if (!["carried", "waiting"].includes(String(listing.sourceStatus || "")) || String(general.status || "") === "captured") return false;
      // A general can only be represented by one active market listing.
      if (Object.entries(this.world?.marketListings || {}).some(([id, item]) => String(id) !== listingId && String(item?.generalId || "") === String(listing.generalId || ""))) return false;
      // Records are published from publicMarketListingState; reject extra or
      // malformed fields instead of accepting a client-authored projection.
      if (canonicalJson(publicMarketListingState(this.world, listing)) !== canonicalJson(listing)) return false;
      if (previous && canonicalJson(publicMarketListingState(this.world, previous)) !== canonicalJson(listing)) return false;
    }
    for (const [transactionId, sale] of Object.entries(marketSales)) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(transactionId)) || !sale || typeof sale !== "object") return false;
      if (String(sale.transactionId || "") !== transactionId || String(sale.buyerAccountId || "") !== actorAccountId) return false;
      const listing = this.world?.marketListings?.[String(sale.listingId || "")];
      const previousSale = this.world?.marketSales?.[transactionId];
      if (previousSale && canonicalJson(previousSale) === canonicalJson(sale)) continue;
      if (!listing || String(listing.sellerAccountId || "") === actorAccountId || String(sale.sellerAccountId || "") !== String(listing.sellerAccountId || "")) return false;
      // A purchase and its public listing removal are one atomic map delta.
      // Without this check a forged sale could leave the listing available for
      // a second buyer while still crediting the seller.
      if (!Object.hasOwn(marketListings, String(sale.listingId || "")) || marketListings[String(sale.listingId || "")] !== null) return false;
      if (Number(sale.price) !== Number(listing.price) || String(sale.generalId || "") !== String(listing.generalId || "")) return false;
      if (!sale.general || typeof sale.general !== "object" || String(sale.general.id || "") !== String(listing.generalId || "")) return false;
      if (canonicalJson(sale.general) !== canonicalJson(listing.general)) return false;
      if (JSON.stringify(sale).length > 80000) return false;
    }
    for (const [id, claim] of Object.entries(treasureClaims)) {
      const source = this.publicTreasureSources[id];
      const spawn = this.world?.treasureSpawns?.[id] || this.world?.claimedTreasures?.[id] || source?.spawn;
      if (!claim || !spawn || String(claim.treasureId || "") !== id || String(claim.accountId || "") !== actorAccountId) return false;
      if (Number(claim.epoch) !== Number(spawn.epoch) || Number(claim.x) !== Number(spawn.x) || Number(claim.y) !== Number(spawn.y)) return false;
      if (!MATERIAL_BY_ID[String(claim.materialId || "")] || (spawn.materialId && String(claim.materialId) !== String(spawn.materialId))) return false;
      if (source?.introducedOrder && compareOrderValue(order, source.introducedOrder) < 0) return false;
      if (source?.retiredOrder && compareOrderValue(order, source.retiredOrder) >= 0) return false;
    }
    return true;
  }

  validAuthorityDirective(item) {
    const record = item?.record;
    if (record?.schema !== FYOW_SCHEMAS.authority || record.gameId !== GRID_GAME_ID || record.workId !== this.work?.id || record.seasonId !== this.control?.seasonId) return false;
    if (!this.work?.authorAccountId || String(record.authorityAccountId || "") !== this.work.authorAccountId || String(this.control?.authorityAccountId || "") !== this.work.authorAccountId) return false;
    if (!this.validAuthorSource(item) || !recordPlatformOrder(item).timestamp || !verifySignedRecord(record, this.control.authoritySigningPublicKey)) return false;
    if (record.type === "treasure-scatter") {
      const spawns = record.treasureSpawns;
      if (!Number.isSafeInteger(record.treasureEpoch) || record.treasureEpoch < 0 || !spawns || typeof spawns !== "object" || Array.isArray(spawns) || Object.keys(spawns).length > GRID_SIZE * GRID_SIZE) return false;
      return Object.entries(spawns).every(([id, spawn]) => spawn && spawn.id === id && validPosition(spawn)
        && Number.isSafeInteger(spawn.epoch) && spawn.epoch > 0 && spawn.epoch <= record.treasureEpoch && MATERIAL_BY_ID[String(spawn.materialId || "")]);
    }
    if (record.type === "simulate-player-intent") {
      const targetAccountId = String(record.targetAccountId || "");
      const intent = record.intent;
      const general = record.general;
      if (!targetAccountId || !intent || typeof intent !== "object" || Array.isArray(intent)) return false;
      if (String(intent.type || "") !== "recall-general" || !general || typeof general !== "object" || Array.isArray(general)) return false;
      if (String(intent.generalId || "") !== String(general.id || "") || String(general.holderAccountId || "") !== targetAccountId) return false;
      if (general.status !== "deployed" || !validPosition(general.location) || JSON.stringify(general).length > 30000) return false;
      const currentEpoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[targetAccountId] || 0)));
      return Math.max(0, Math.trunc(Number(record.playerEpoch || 0))) === currentEpoch;
    }
    if (!["player-reset", "player-ban", "player-unban"].includes(String(record.type || ""))) return false;
    return Boolean(String(record.targetAccountId || "").trim());
  }

  clearResetLocalPlayer(targetAccountId) {
    if (String(targetAccountId) !== this.account().accountId) return;
    this.localEvents = [];
    this.localPreferences = { orientation: "any", characterProfileId: "", characterTags: [], initialGeneralWish: "", characterProfile: null, playerContext: null };
    this.directInbox = [];
    this.directHistory = [];
    this.seenDirectMessageIds.clear();
    this.modelConversationIds.clear();
    this.pendingJoinPreview = null;
  }

  applyAuthorityPlayerActions() {
    if (!this.world) return 0;
    normalizeWorldState(this.world);
    const accountId = this.account().accountId;
    const player = this.world.players?.[accountId];
    if (!accountId || !player) return 0;
    const privatePlayer = this.world.privatePlayers[accountId] ||= {};
    privatePlayer.appliedAuthorityPlayerActions ||= [];
    const applied = new Set(privatePlayer.appliedAuthorityPlayerActions.map(String));
    let count = 0;
    const actions = Object.values(this.world.authorityPlayerActions || {})
      .filter(action => String(action?.targetAccountId || "") === accountId)
      .sort((left, right) => Number(left?.issuedAt || 0) - Number(right?.issuedAt || 0));
    for (const action of actions) {
      const actionId = String(action?.authorityId || "");
      if (!actionId || applied.has(actionId)) continue;
      const currentEpoch = Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[accountId] || 0)));
      if (Math.max(0, Math.trunc(Number(action.playerEpoch || 0))) !== currentEpoch) continue;
      if (String(action.intent?.type || "") === "recall-general") {
        const archive = cloneJson(action.general);
        if (!archive || String(archive.holderAccountId || "") !== accountId || String(archive.id || "") !== String(action.intent.generalId || "")) continue;
        archive.status = "carried";
        archive.location = null;
        archive.experienceUpdatedAt = Math.max(Number(archive.experienceUpdatedAt || 0), Number(action.issuedAt || 0));
        ensureGeneralProfile(archive);
        this.world.generals[archive.id] = archive;
        player.carriedGeneralIds = [...new Set([...(player.carriedGeneralIds || []).map(String), String(archive.id)])];
      } else continue;
      applied.add(actionId);
      count += 1;
    }
    privatePlayer.appliedAuthorityPlayerActions = [...applied].slice(-500);
    return count;
  }

  applyAuthorityDirective(item) {
    if (!this.validAuthorityDirective(item)) return false;
    const record = item.record;
    const id = String(record.authorityId || record.id || "");
    const order = recordPlatformOrder(item);
    if (!id || this.appliedAuthorityIds.has(id) || compareOrderValue(order, this.publicMapBaselineOrder) <= 0) return false;
    normalizeWorldState(this.world);
    const target = String(record.targetAccountId || "");
    const authorityKey = record.type === "treasure-scatter"
      ? "treasure-scatter"
      : record.type === "simulate-player-intent"
        ? `simulate:${id}`
        : `${record.type === "player-reset" ? "reset" : "ban"}:${target}`;
    if (compareOrderValue(order, this.publicAuthorityOrders[authorityKey] || this.publicMapBaselineOrder) <= 0) return false;
    if (record.type === "treasure-scatter") {
      if (record.treasureEpoch < this.world.treasureEpoch) return false;
      this.rememberTreasureSources(this.world.treasureSpawns);
      this.rememberTreasureSources(record.treasureSpawns, order, record.treasureEpoch);
      this.world.treasureEpoch = record.treasureEpoch;
      this.world.treasureSpawns = Object.fromEntries(Object.entries(record.treasureSpawns).filter(([treasureId]) => !this.world.claimedTreasures[treasureId]).map(([treasureId, spawn]) => [treasureId, cloneJson(spawn)]));
    } else if (record.type === "simulate-player-intent") {
      const action = {
        authorityId: id,
        targetAccountId: target,
        playerEpoch: Math.max(0, Math.trunc(Number(record.playerEpoch || 0))),
        intent: cloneJson(record.intent),
        general: cloneJson(record.general),
        issuedAt: Number(record.issuedAt || 0)
      };
      this.world.authorityPlayerActions[id] = action;
      const generalId = String(record.intent.generalId || "");
      const location = record.general.location;
      const locationKey = `${location.x},${location.y}`;
      const cell = this.world.cells?.[locationKey];
      if (cell && String(cell.ownerAccountId || "") === target) {
        cell.generalIds = (cell.generalIds || []).filter(candidate => String(candidate) !== generalId);
        this.publicCellOrders[locationKey] = order;
        delete this.publicCellWriteBases[locationKey];
      }
      delete this.world.generals[generalId];
      delete this.localDeployedGeneralProgress[generalId];
      this.publicGeneralOrders[generalId] = order;
      const retained = Object.entries(this.world.authorityPlayerActions)
        .sort(([, left], [, right]) => Number(right?.issuedAt || 0) - Number(left?.issuedAt || 0))
        .slice(0, 500);
      this.world.authorityPlayerActions = Object.fromEntries(retained);
      this.applyAuthorityPlayerActions();
    } else if (record.type === "player-reset") {
      const targetEpoch = Number(record.playerEpoch);
      if (Number.isSafeInteger(targetEpoch) && targetEpoch <= Number(this.world.playerEpochs[target] || 0)) {
        this.appliedAuthorityIds.add(id);
        this.publicAuthorityOrders[authorityKey] = order;
        return false;
      }
      const ownedCells = Object.entries(this.world.cells).filter(([, cell]) => String(cell?.ownerAccountId || "") === target).map(([key]) => key);
      const ownedGenerals = Object.entries(this.world.generals).filter(([, general]) => String(general?.holderAccountId || "") === target).map(([generalId]) => generalId);
      resetPlayerState(this.world, target, Number(record.playerEpoch));
      for (const key of ownedCells) {
        this.publicCellOrders[key] = order;
        delete this.publicCellWriteBases[key];
      }
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
    this.publicAuthorityOrders[authorityKey] = order;
    if (this.appliedAuthorityIds.size > 1000) this.appliedAuthorityIds = new Set([...this.appliedAuthorityIds].slice(-1000));
    if (compareOrderValue(order, this.publicMapOrder) > 0) this.publicMapOrder = order;
    return true;
  }

  applyMapDelta(item) {
    if (!this.validMapDelta(item)) {
      if (item?.record?.schema === FYOW_SCHEMAS.mapDelta && item.record.workId === this.work?.id) {
        this.diagnostic({ event: "map-delta-rejected", code: "FYOW_MAP_DELTA_INVALID",
          mapDeltaId: item.record.mapDeltaId, actorAccountId: item.record.actorAccountId,
          cells: Object.keys(item.record.changes?.cells || {}), order: recordPlatformOrder(item) });
      }
      return false;
    }
    const record = item.record;
    const actorAccountId = String(record.actorAccountId);
    const order = recordPlatformOrder(item);
    if (this.appliedMapDeltaIds.has(String(record.mapDeltaId)) || compareOrderValue(order, this.publicMapBaselineOrder) <= 0) return false;
    for (const [key, cell] of Object.entries(record.changes.cells)) {
      if (compareOrderValue(order, this.publicCellOrders[key] || this.publicMapBaselineOrder) <= 0) continue;
      const envelope = occupationEnvelope(record.changes, key);
      const nextCell = effectivePublicCell(record.changes, key, this.world.cells[key]);
      if (nextCell == null) {
        if (this.world.cells[key]?.ownerAccountId !== actorAccountId) continue;
        delete this.world.cells[key];
      }
      else this.world.cells[key] = cloneJson(nextCell);
      this.publicCellOrders[key] = order;
      if (envelope.modern) this.publicCellWriteBases[key] = occupationBaseDescriptor(envelope);
      else delete this.publicCellWriteBases[key];
    }
    for (const [id, general] of Object.entries(record.changes.generals)) {
      if (compareOrderValue(order, this.publicGeneralOrders[id] || this.publicMapBaselineOrder) <= 0) continue;
      if (general == null) {
        const existing = this.world.generals[id];
        const transition = record.changes.generalTransitions?.[id];
        const transitionValid = validGeneralTransitionShape(id, transition);
        const locationKey = transitionValid ? `${transition.from.x},${transition.from.y}` : "";
        const locationEnvelope = locationKey ? occupationEnvelope(record.changes, locationKey) : null;
        const nextCell = locationEnvelope?.modern ? locationEnvelope.nextCell : locationKey ? record.changes.cells?.[locationKey] : null;
        const locationVerified = transitionValid && isPublicCellShape(nextCell)
          && !(nextCell.generalIds || []).map(String).includes(String(id))
          && compareOrderValue(order, this.publicCellOrders[locationKey] || this.publicMapBaselineOrder) >= 0
          && samePublicCell(this.world.cells[locationKey], nextCell);
        if (!locationVerified) {
          this.diagnostic({
            event: "general-removal-rejected",
            status: "preserved-local-archive",
            generalId: id,
            actorAccountId,
            reason: transition ? "location-verification-failed" : "missing-public-location-proof"
          });
          this.publicGeneralOrders[id] = order;
          continue;
        }
        if (transition.reason === "recalled") this.publicGeneralRecalls[id] = {
          transition: cloneJson(transition), order: cloneJson(order), playerEpoch: Number(record.playerEpoch || 0),
          ...(existing?.status === "deployed" ? { general: publicGeneralState(existing) } : {})
        };
        const viewer = this.account().accountId;
        // A public deployed tombstone is not evidence that a newer private
        // carried/captured/market archive has ceased to exist.
        if (existing && String(existing.holderAccountId || "") === viewer && existing.status !== "deployed") {
          this.diagnostic({ event: "general-removal-rejected", status: "preserved-local-archive", generalId: id, actorAccountId, reason: "private-location-is-newer" });
          this.publicGeneralOrders[id] = order;
          continue;
        }
        if (existing && transition.reason === "recalled" && String(transition.holderAccountId) === viewer) {
          existing.status = "carried";
          existing.location = null;
          const player = this.world.players?.[viewer];
          if (player) player.carriedGeneralIds = [...new Set([...(player.carriedGeneralIds || []).map(String), String(id)])];
        } else if (existing && transition.reason === "captured" && String(transition.nextHolderAccountId) === viewer) {
          existing.status = "captured";
          existing.location = { x: Number(transition.from.x), y: Number(transition.from.y) };
          existing.capturedFromAccountId = String(transition.holderAccountId);
          existing.holderAccountId = viewer;
          const player = this.world.players?.[viewer];
          if (player) player.carriedGeneralIds = (player.carriedGeneralIds || []).filter(candidate => String(candidate) !== String(id));
        } else {
          delete this.world.generals[id];
          delete this.localDeployedGeneralProgress[id];
          const player = this.world.players?.[viewer];
          if (player) player.carriedGeneralIds = (player.carriedGeneralIds || []).filter(candidate => String(candidate) !== String(id));
        }
      }
      else {
        const existing = this.world.generals[id];
        const isOwnPrivateArchive = String(existing?.holderAccountId || "") === this.account().accountId
          && existing?.status !== "deployed";
        const cell = this.world.cells[`${general.location.x},${general.location.y}`];
        const verifiedDeployment = cell?.ownerAccountId === general.holderAccountId && cell.generalIds?.includes(id)
          && compareOrderValue(order, this.localGeneralArchiveOrders[id]) >= 0;
        if (!isOwnPrivateArchive || verifiedDeployment) {
          this.world.generals[id] = mergeGeneralHistories(existing, publicGeneralState(cloneJson(general)));
          if (general.holderAccountId === this.account().accountId) this.localGeneralArchiveOrders[id] = cloneJson(order);
        }
        this.applyLocalDeployedGeneralProgress();
      }
      this.publicGeneralOrders[id] = order;
    }
    this.world.marketListings ||= {};
    this.world.marketSales ||= {};
    for (const [listingId, listing] of Object.entries(record.changes.marketListings || {})) {
      if (compareOrderValue(order, this.publicMarketOrders[listingId] || this.publicMapBaselineOrder) <= 0) continue;
      if (listing == null) delete this.world.marketListings[listingId];
      else this.world.marketListings[listingId] = cloneJson(listing);
      this.publicMarketOrders[listingId] = order;
    }
    for (const [transactionId, sale] of Object.entries(record.changes.marketSales || {})) {
      if (compareOrderValue(order, this.publicMarketSaleOrders[transactionId] || this.publicMapBaselineOrder) <= 0) continue;
      if (sale == null) continue;
      this.world.marketSales[transactionId] = cloneJson(sale);
      this.publicMarketSaleOrders[transactionId] = order;
      if (String(sale.sellerAccountId || "") === this.account().accountId) this.applyMarketSaleToSeller(sale);
    }
    for (const [id, claim] of Object.entries(record.changes.claimedTreasures || {})) {
      const previous = this.world.claimedTreasures?.[id];
      const previousOrder = previous?.platformOrder;
      if (previous && (!previousOrder || compareOrderValue(order, previousOrder) >= 0)) continue;
      this.world.claimedTreasures ||= {};
      this.world.claimedTreasures[id] = { ...cloneJson(claim), platformOrder: order };
      delete this.world.treasureSpawns[id];
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
        commentRootId: existing.commentRootId || order.commentId || null
      };
      if (actorAccountId !== this.account().accountId) delete this.world.players[actorAccountId].position;
      this.publicParticipantOrders[actorAccountId] = order;
    }
    this.world.revision = Number(this.world.revision || 0) + 1;
    this.rememberConquests(record.changes.conquests, order);
    this.appliedMapDeltaIds.add(String(record.mapDeltaId));
    if (this.appliedMapDeltaIds.size > 4000) this.appliedMapDeltaIds = new Set([...this.appliedMapDeltaIds].slice(-4000));
    if (compareOrderValue(order, this.publicMapOrder) > 0) this.publicMapOrder = order;
    this.publicDeltaCountSinceSnapshot += 1;
    this.diagnostic({
      event: "player-behavior",
      source: "public-ledger",
      behavior: {
        mapDeltaId: String(record.mapDeltaId || ""),
        actorAccountId,
        createdAt: order.timestamp,
        cells: cloneJson(record.changes.cells || {}),
        generals: cloneJson(record.changes.generals || {}),
        generalTransitions: cloneJson(record.changes.generalTransitions || {}),
        claimedTreasures: cloneJson(record.changes.claimedTreasures || {}),
        battles: cloneJson(record.changes.battles || {})
      }
    });
    return true;
  }

  rememberConquests(conquests = {}, order = null) {
    if (!this.world) return;
    this.world.conquests ||= {};
    for (const [id, battle] of Object.entries(conquests || {})) {
      if (!this.world.conquests[id]) this.world.conquests[id] = {
        ...cloneJson(battle), ...(order?.timestamp ? { createdAt: order.timestamp, platformOrder: cloneJson(order) } : {})
      };
    }
    // Keep the latest twenty per defender, including players currently offline.
    const counts = new Map();
    this.world.conquests = Object.fromEntries(Object.entries(this.world.conquests)
      .sort(([, a], [, b]) => Number(b.createdAt) - Number(a.createdAt))
      .filter(([, battle]) => {
        const key = `${battle.targetOwnerAccountId}:${battle.targetPlayerEpoch}`;
        counts.set(key, Number(counts.get(key) || 0) + 1);
        return counts.get(key) <= 20;
      }));
    this.reconcileConquestReports();
  }

  reconcileConquestReports() {
    const accountId = this.account().accountId;
    if (!this.world?.players?.[accountId]) return;
    const preferences = this.world.privatePlayers[accountId] ||= {};
    const seen = new Set(preferences.seenConquestReportIds || []);
    for (const battle of Object.values(this.world.conquests || {}).sort((a, b) => a.createdAt - b.createdAt)) {
      if (battle.targetOwnerAccountId !== accountId || Number(battle.targetPlayerEpoch || 0) !== Number(this.world.playerEpochs?.[accountId] || 0)) continue;
      const cell = this.world.cells[`${battle.x},${battle.y}`];
      for (const captured of battle.capturedOwnGenerals || []) {
        const general = this.world.generals[captured.id];
        if (!general || general.holderAccountId !== accountId || general.status !== "deployed"
          || general.location?.x !== battle.x || general.location?.y !== battle.y
          || cell?.ownerAccountId !== battle.attackerAccountId || cell.generalIds?.includes(captured.id)
          || !battle.platformOrder || compareOrderValue(battle.platformOrder, this.publicGeneralOrders[captured.id]) < 0) continue;
        preferences.capturedGeneralArchives ||= {};
        preferences.capturedGeneralArchives[captured.id] = { ...cloneJson(general), capturedByAccountId: battle.attackerAccountId, capturedAt: battle.createdAt };
        delete this.world.generals[captured.id];
        delete this.localDeployedGeneralProgress[captured.id];
        this.world.players[accountId].carriedGeneralIds = (this.world.players[accountId].carriedGeneralIds || []).filter(id => id !== captured.id);
      }
      const id = `loss:${battle.battleId}`;
      if (seen.has(id)) continue;
      recordBattleReport(this.world, accountId, {
        ...battle, id, jobId: battle.battleId, kind: "territory-loss", outcome: "defeat",
        target: { x: battle.x, y: battle.y }, ownLosses: battle.defenderLosses, ownSurvivors: battle.defenderSurvivors
      });
      seen.add(id);
    }
    preferences.seenConquestReportIds = [...seen].slice(-1000);
  }

  applyMarketSaleToSeller(sale) {
    const transactionId = String(sale?.transactionId || "");
    if (!transactionId || this.marketSettledSales.has(transactionId)) return false;
    const accountId = this.account().accountId;
    if (String(sale?.sellerAccountId || "") !== accountId) return false;
    const player = this.world?.players?.[accountId];
    if (!player) return false;
    const generalId = String(sale.generalId || "");
    const general = this.world.generals?.[generalId];
    if (general && String(general.holderAccountId || "") === accountId && String(general.marketListingId || "") === String(sale.listingId || "")) {
      delete this.world.generals[generalId];
      player.carriedGeneralIds = (player.carriedGeneralIds || []).filter(id => String(id) !== generalId);
    }
    player.gold = Math.max(0, Math.trunc(Number(player.gold || 0)) + Math.max(0, Math.trunc(Number(sale.price || 0))));
    this.marketSettledSales.add(transactionId);
    if (this.marketSettledSales.size > 1000) this.marketSettledSales = new Set([...this.marketSettledSales].slice(-1000));
    return true;
  }

  applyMapDeltas(records) {
    return records
      .filter(item => item.record?.schema === FYOW_SCHEMAS.mapDelta)
      .sort(comparePlatformOrder)
      .reduce((count, item) => count + Number(this.applyMapDelta(item)), 0);
  }

  currentWorldChat() {
    const entries = (this.worldChat || [])
      .filter(item => item && String(item.messageId || "") && String(item.text || ""))
      .filter(item => {
        const actor = String(item.accountId || "");
        if (!actor || item.seasonId !== this.control?.seasonId || this.world?.bans?.[actor]?.banned) return false;
        const epoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[actor] || 0)));
        return Math.max(0, Math.trunc(Number(item.playerEpoch || 0))) === epoch;
      })
      .sort((left, right) => Number(left.platformTimestamp || left.createdAt || 0) - Number(right.platformTimestamp || right.createdAt || 0)
        || String(left.commentId || left.messageId).localeCompare(String(right.commentId || right.messageId)));
    return entries.slice(-WORLD_CHAT_LIMIT).map(item => ({ ...item, createdAt: Number(item.platformTimestamp || item.createdAt || 0) }));
  }

  validWorldChat(item) {
    const record = item?.record;
    if (!record || record.schema !== FYOW_SCHEMAS.worldChat || record.gameId !== GRID_GAME_ID
      || record.workId !== this.work?.id || record.seasonId !== this.control?.seasonId) return false;
    const actorAccountId = String(record.accountId || "");
    const player = this.world?.players?.[actorAccountId];
    if (!actorAccountId || !player || this.world?.bans?.[actorAccountId]?.banned) return false;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(record.messageId || "")) || !record.deviceSigningPublicKey || !verifySignedRecord(record, record.deviceSigningPublicKey)) return false;
    const currentEpoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[actorAccountId] || 0)));
    if (Math.max(0, Math.trunc(Number(record.playerEpoch || 0))) !== currentEpoch) return false;
    const displayName = String(record.displayName || "").trim();
    if (!displayName || displayName !== String(player.displayName || "").trim()) return false;
    let text;
    try { text = normalizeWorldChatText(record.text); } catch { return false; }
    if (text !== String(record.text)) return false;
    const sources = Array.isArray(item.sources) ? item.sources : [];
    if (!sources.length || !recordPlatformOrder(item).timestamp) return false;
    if (!sources.every(source => commentAccountId(source) === actorAccountId)) return false;
    return true;
  }

  applyWorldChatRecord(item) {
    if (!this.validWorldChat(item)) return false;
    const record = item.record;
    const order = recordPlatformOrder(item);
    const messageId = String(record.messageId);
    const existingIndex = this.worldChat.findIndex(candidate => String(candidate.messageId) === messageId
      && String(candidate.accountId) === String(record.accountId)
      && Number(candidate.playerEpoch || 0) === Number(record.playerEpoch || 0));
    if (existingIndex >= 0) {
      const existing = this.worldChat[existingIndex];
      if (compareOrderValue(order, { timestamp: Number(existing.platformTimestamp || existing.createdAt || 0), commentId: existing.commentId || "" }) >= 0) return false;
      this.worldChat.splice(existingIndex, 1);
    }
    this.worldChat.push({
      messageId,
      displayName: String(record.displayName).slice(0, 40),
      text: String(record.text),
      createdAt: Number(order.timestamp),
      platformTimestamp: Number(order.timestamp),
      commentId: String(order.commentId || ""),
      accountId: String(record.accountId),
      seasonId: String(record.seasonId),
      playerEpoch: Math.max(0, Math.trunc(Number(record.playerEpoch || 0)))
    });
    this.worldChat = this.worldChat
      .sort((left, right) => Number(left.platformTimestamp || 0) - Number(right.platformTimestamp || 0)
        || String(left.commentId || "").localeCompare(String(right.commentId || "")))
      .slice(-WORLD_CHAT_LIMIT);
    this.diagnostic({
      event: "player-behavior",
      source: "public-world-chat",
      behavior: { type: "world-chat", accountId: String(record.accountId), messageId, text: String(record.text), createdAt: Number(order.timestamp) }
    });
    return true;
  }

  applyWorldChatRecords(records, { replace = false } = {}) {
    const candidates = (records || [])
      .filter(item => item?.record?.schema === FYOW_SCHEMAS.worldChat)
      .sort(comparePlatformOrder);
    if (replace) this.worldChat = [];
    let applied = 0;
    for (const item of candidates) if (this.applyWorldChatRecord(item)) applied += 1;
    this.worldChat = this.currentWorldChat().slice(-WORLD_CHAT_LIMIT);
    return applied;
  }

  consumeWorldChatBudget() {
    const now = this.now();
    this.worldChatSendTimes = this.worldChatSendTimes.filter(timestamp => now - timestamp < DIRECT_RATE_WINDOW_MS);
    if (this.worldChatSendTimes.length >= WORLD_CHAT_SEND_LIMIT) throw new Error("世界聊天发送过于频繁，请稍后再试");
    this.worldChatSendTimes.push(now);
  }

  async submitWorldChat(intent, account) {
    const actor = this.world.players?.[account.accountId];
    if (!actor) throw new Error("请先加入在线游戏世界");
    const text = normalizeWorldChatText(intent.text);
    const playerEpoch = Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[account.accountId] || 0)));
    const messageId = sha256(Buffer.from(canonicalJson({
      workId: this.work.id, seasonId: this.control.seasonId, accountId: account.accountId, playerEpoch, idempotencyKey: intent.idempotencyKey
    }))).slice(0, 48);
    if (this.currentWorldChat().some(message => message.messageId === messageId && message.accountId === account.accountId)) return { duplicate: true, state: this.state() };
    this.consumeWorldChatBudget();
    const identity = await this.getIdentity();
    const record = signRecord({
      schema: FYOW_SCHEMAS.worldChat,
      messageId,
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      accountId: account.accountId,
      displayName: String(actor.displayName || account.username || "玩家").trim().slice(0, 40),
      text,
      createdAt: this.now(),
      playerEpoch,
      deviceSigningPublicKey: identity.signingPublicKey
    }, identity.signingPrivateKey);
    const sources = await this.postRecord(record);
    let item = { record, sources };
    if (!this.applyWorldChatRecord(item)) throw new Error("世界聊天发布后未通过来源与签名校验");
    const message = this.currentWorldChat().find(candidate => candidate.messageId === record.messageId && candidate.accountId === account.accountId) || null;
    this.saveCache();
    this.notify();
    return {
      event: null,
      mapDelta: null,
      effects: [],
      deferredEffects: [],
      snapshotWarning: null,
      dialogue: null,
      worldChat: message,
      state: this.state()
    };
  }

  async readWorldChatHistory(history = null) {
    if (!this.work) return { comments: [], assembled: { records: [], incomplete: [], invalid: [] } };
    const seasonId = String(this.control?.seasonId || "");
    const cursor = this.worldChatCursor?.seasonId === seasonId && this.worldChatCursor?.initialized
      ? this.worldChatCursor : null;
    let comments = Array.isArray(cursor?.pendingChunks) ? cloneJson(cursor.pendingChunks).slice(-512) : [];
    const seen = new Set(comments.map(commentId).filter(Boolean));
    let pagesRead = 0;
    const pages = history?.pages || new Map();
    const fetchedRoots = new Set();
    const recent = new Map();
    const readPage = async page => {
      if (pages.has(page)) return pages.get(page);
      const result = await this.readHistoryPage(page);
      pages.set(page, result);
      pagesRead += 1;
      return result;
    };
    const tailPage = history?.tailPage || await this.locateHistoryTailPage(readPage);
    this.historyTailPage = tailPage;
    const knownOrder = history?.pageOrder || this.historyPageOrder;
    const pageOrder = ["newest-first", "oldest-first", "mixed"].includes(knownOrder) ? knownOrder : "mixed";
    const count = Math.min(tailPage, WORLD_CHAT_SCAN_PAGES);
    const scanPages = Array.from({ length: count }, (_, index) => pageOrder === "newest-first" ? index + 1 : tailPage - index);
    let assembled = { records: [], incomplete: [], invalid: [] };
    let newestOrder = cursor?.order || { timestamp: 0, commentId: "" };
    let reachedHistoryBoundary = false;
    let pagesScanned = 0;
    for (const page of scanPages) {
      const pageComments = await readPage(page);
      pagesScanned += 1;
      if (!commentPageRootCount(pageComments)) break;
      const pageOrders = commentPageRoots(pageComments).map(comment => ({ timestamp: commentTimestamp(comment), commentId: commentId(comment) }))
        .filter(order => order.timestamp && order.commentId);
      for (const order of pageOrders) if (compareOrderValue(order, newestOrder) > 0) newestOrder = order;
      for (const comment of pageComments) {
        const id = commentId(comment);
        if (!id || seen.has(id) || decodeCommentChunk(comment.content)?.kind !== "WCHAT") continue;
        seen.add(id);
        comments.push(comment);
      }
      comments = (await this.hydrateCommentReplies(comments, assembleCommentRecords(comments), fetchedRoots))
        .filter(comment => decodeCommentChunk(comment.content)?.kind === "WCHAT");
      assembled = assembleCommentRecords(comments);
      for (const item of assembled.records.filter(candidate => this.validWorldChat(candidate))) {
        const key = `${item.record.accountId}:${item.record.messageId}`;
        const previous = recent.get(key);
        if (!previous || comparePlatformOrder(item, previous) < 0) recent.set(key, item);
      }
      const newest = [...recent.entries()].sort((left, right) => comparePlatformOrder(right[1], left[1])).slice(0, WORLD_CHAT_LIMIT);
      recent.clear();
      for (const [key, item] of newest) recent.set(key, item);
      const missingRoot = assembled.incomplete.some(item => !(item.sources || []).some(source => decodeCommentChunk(source.content)?.part === 1));
      if (cursor && pageOrder !== "mixed" && !missingRoot && pageOrders.some(order => compareOrderValue(order, cursor.order) <= 0)) {
        reachedHistoryBoundary = true;
        break;
      }
      if (pageOrder !== "mixed" && !assembled.incomplete.length && recent.size >= WORLD_CHAT_LIMIT) break;
      comments = assembled.incomplete.slice(-512).flatMap(item => item.sources || []);
    }
    this.worldChatCursor = {
      seasonId,
      initialized: true,
      order: newestOrder,
      tailPage,
      pageOrder,
      pendingChunks: assembled.incomplete.flatMap(item => item.sources || []).slice(-512)
    };
    return {
      comments,
      assembled: { ...assembled, records: [...recent.values()].sort(comparePlatformOrder) },
      pagesRead,
      pagesScanned,
      incremental: Boolean(cursor),
      reachedHistoryBoundary
    };
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
    if (this.syncPaused || !this.work || this.intentInFlight || this.migrationActive) return this.state();
    if (this.syncInFlight) return this.syncInFlight;
    const running = this.syncNow(fullScan);
    this.syncInFlight = running;
    try {
      return await running;
    } finally {
      if (this.syncInFlight === running) this.syncInFlight = null;
    }
  }

  async syncNow(fullScan = false, { ignoreMigrationReset = false } = {}) {
    const previousControlId = String(this.control?.id || "");
    const previousDirectSession = this.directSession();
    this.syncing = true;
    this.commentReadSession = { pages: new Map(), branches: new Map(), comments: new Map(), failedRoots: new Map(), totalRoots: null };
    this.error = null;
    this.notify();
    try {
      if (this.lastClockCalibrationMono == null || this.monotonicNow() - this.lastClockCalibrationMono > 60 * 60 * 1000) await this.calibrateClock().catch(() => null);
      if (fullScan && !ignoreMigrationReset) {
        const reset = await this.probeMigrationReset();
        if (reset) {
          this.pendingMigration = this.migrationStateFromDetectedReset(reset);
          this.control = null;
          this.world = null;
          this.mapFactsCache = null;
          this.status = "migrating";
          this.lastSyncAt = this.now();
          this.saveCache();
          this.diagnostic({ event: "migration-detected", status: this.status, targetWorkId: reset.record.newWorkId, controlId: null, fastPath: true });
          this.notify();
          return this.state();
        }
      }
      let history;
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            history = await this.readHistory(Boolean(fullScan || !this.control || this.pendingTreasureRewards().length));
            break;
          } catch (error) {
            if (error.code !== "FYOW_HISTORY_CHANGED" || attempt === 2) throw error;
            this.commentReadSession = { pages: new Map(), branches: new Map(), comments: new Map(), failedRoots: new Map(), totalRoots: null };
            this.historyTailPage = 1;
            this.updateLoadProgress({ phase: "reading", readComments: 0, totalComments: null });
          }
        }
      } catch (error) {
        if (!this.syncPaused && this.world && this.control) {
          try { await this.settleLocalClock(this.now(), { localOnly: true }); }
          catch (settleError) { this.diagnostic({ event: "local-travel-settle-failed", error: settleError?.message || String(settleError) }); }
        }
        throw error;
      }
      this.assertSyncActive();
      const controls = this.verifiedControls(history.assembled.records);
      if (controls[0]) {
        this.control = controls[0].record;
        this.controlPlatformOrder = recordPlatformOrder(controls[0]);
        if (previousDirectSession && !this.sameDirectSession(previousDirectSession, this.directSession())) this.clearDirectSession();
      }
      // The reset is self-verifying so an old game card can follow it without
      // loading the obsolete work's full ledger first.
      if (!this.control && !ignoreMigrationReset) {
        const reset = this.verifiedResetsWithoutControl(history.assembled.records)[0];
        if (reset) {
          this.pendingMigration = this.migrationStateFromDetectedReset(reset);
          this.control = null;
          this.world = null;
          this.mapFactsCache = null;
          this.status = "migrating";
          this.lastSyncAt = this.now();
          this.saveCache();
          this.diagnostic({ event: "migration-detected", status: this.status, targetWorkId: reset.record.newWorkId, controlId: null });
          this.notify();
          return this.state();
        }
      }
      if (this.control) {
        const reset = ignoreMigrationReset ? null : this.verifiedResets(history.assembled.records)[0];
        if (reset) {
          const pendingMigration = this.migrationStateFromDetectedReset(reset);
          const retainSourceState = Boolean(
            pendingMigration.requiresPublish
            && this.migrationDraft
            && String(this.migrationDraft.sourceWorkId || "") === String(this.work?.id || "")
            && this.world
            && this.isAuthority()
          );
          this.pendingMigration = pendingMigration;
          if (!retainSourceState) {
            this.control = null;
            this.world = null;
            this.mapFactsCache = null;
          }
          this.status = "migrating";
          this.lastSyncAt = this.now();
          this.saveCache();
          this.diagnostic({ event: "migration-detected", status: this.status, targetWorkId: reset.record.newWorkId, controlId: this.control?.id || null });
          this.notify();
          return this.state();
        }
        if (!this.pendingMigration?.requiresPublish) this.pendingMigration = null;
        if (this.loadProgress?.active && !controls.length) throw new Error("云端控制记录尚未读取完整，请重试同步");
        const snapshots = this.verifiedSnapshots(history.assembled.records);
        const snapshotItem = snapshots[0];
        const snapshot = snapshotItem?.record;
        if (this.loadProgress?.active && !snapshot) throw new Error("云端状态记录尚未读取完整，请重试同步");
        if (this.migrationProof) {
          const proof = this.migrationProof;
          const anchorControl = proof.targetControlId
            ? controls.find(item => String(item.record.id || "") === String(proof.targetControlId))?.record
            : null;
          if (proof.targetControlId && !anchorControl) throw new Error("迁移目标控制记录不匹配");
          if (proof.seasonId && String(this.control.seasonId || "") !== String(proof.seasonId)) throw new Error("迁移目标赛季不匹配");
          if (proof.authoritySigningPublicKey && String(this.control.authoritySigningPublicKey || "") !== String(proof.authoritySigningPublicKey)) throw new Error("迁移目标权威密钥不匹配");
          if (anchorControl && proof.targetProgramHash && String(anchorControl.programHash || "") !== String(proof.targetProgramHash)) throw new Error("迁移目标程序摘要不匹配");
          if (anchorControl && proof.seasonId && String(anchorControl.seasonId || "") !== String(proof.seasonId)) throw new Error("迁移锚点赛季不匹配");
          if (anchorControl && proof.authoritySigningPublicKey && String(anchorControl.authoritySigningPublicKey || "") !== String(proof.authoritySigningPublicKey)) throw new Error("迁移锚点权威密钥不匹配");
          if (proof.targetSnapshotId && !snapshots.some(item => String(item.record.snapshotId || "") === String(proof.targetSnapshotId))) throw new Error("迁移目标快照不匹配");
        }
        const snapshotOrder = recordPlatformOrder(snapshotItem);
        const snapshotIsNewer = snapshot && (!this.world || compareOrderValue(snapshotOrder, this.publicMapOrder) > 0);
        if (snapshotIsNewer) {
          const localOverlay = this.captureLocalOverlay();
          const coverage = snapshotCoverage(snapshot);
          this.world = normalizeWorldState(cloneJson(snapshot.state));
          this.publicMapOrder = snapshotOrder;
          this.publicMapBaselineOrder = ledgerOrder(coverage?.through);
          this.publicHistoryOrder = ledgerOrder(coverage?.through);
          this.appliedMapDeltaIds = new Set(coverage?.appliedMapDeltaIds || []);
          this.appliedAuthorityIds = new Set(coverage?.appliedAuthorityIds || []);
          this.publicDeltaCountSinceSnapshot = 0;
          this.publicCellOrders = cloneJson(coverage?.cellOrders || {});
          this.publicCellWriteBases = cloneJson(coverage?.cellWriteBases || {});
          this.publicGeneralOrders = cloneJson(coverage?.generalOrders || {});
          this.publicGeneralRecalls = cloneJson(coverage?.generalRecalls || {});
          this.publicMarketOrders = cloneJson(coverage?.marketOrders || {});
          this.publicMarketSaleOrders = cloneJson(coverage?.marketSaleOrders || {});
          this.publicParticipantOrders = cloneJson(coverage?.participantOrders || {});
          this.publicAuthorityOrders = cloneJson(coverage?.authorityOrders || {});
          this.publicTreasureSources = cloneJson(coverage?.treasureSources || {});
          this.restoreLocalOverlay(localOverlay);
        }
        normalizeWorldState(this.world);
        bindWorldAuthority(this.world, this.control);
        if (this.world) {
          this.collectTreasureSources(history.assembled.records);
          this.applyPublicLedger(history.assembled.records);
          this.recoverLegacyGeneralRecalls(history.assembled.records);
          if (this.pendingIntentTransaction?.phase === "prepared" && this.pendingIntentTransaction?.changes
            && !this.appliedMapDeltaIds.has(String(this.pendingIntentTransaction.mapDeltaId))) {
            try {
              await this.retryPendingIntentTransactionPublish();
            } catch (error) {
              this.diagnostic({ event: "intent-transaction-publish-deferred", intentType: this.pendingIntentTransaction?.intentType, error: error?.message || String(error) });
            }
            this.assertSyncActive();
          }
          this.resolvePendingIntentTransaction();
          this.applyAuthorityPlayerActions();
          this.reconcileMarketSales();
          this.reconcileConquestReports();
          if (history.completeThrough && compareOrderValue(history.completeThrough, this.publicHistoryOrder) > 0) this.publicHistoryOrder = { ...history.completeThrough };
        }
        if (this.world) this.reconcileTreasureRewards(history);
        if (this.world) {
          try {
            const chatHistory = await this.readWorldChatHistory(history);
            this.applyWorldChatRecords(chatHistory.assembled.records);
          } catch (error) {
            if (this.loadProgress?.active) throw error;
            this.diagnostic({ event: "world-chat-sync-deferred", error: error?.message || String(error) });
          }
          this.assertSyncActive();
        }
        if (this.world) this.recoverOwnLocalPlayerState();
        if (this.world) await this.settleLocalClock();
        this.assertSyncActive();
        // Model-backed effects are retried only after an explicit player
        // confirmation. Do not spend points or make background model calls
        // during a passive world sync.
        this.assertSyncActive();
        if (this.world && !this.pendingIntentTransaction && this.isAuthority() && this.publicDeltaCountSinceSnapshot >= PUBLIC_LEDGER_COMPACTION_DELTAS) {
          try { await this.publishSnapshot(); }
          catch (error) { this.diagnostic({ event: "snapshot-compaction-deferred", error: error?.message || String(error) }); }
        }
        await this.receiveDirectWakes().catch(error => {
          if (this.loadProgress?.active) throw error;
          return [];
        });
        this.assertSyncActive();
        if (this.pendingIntentTransaction?.phase === "prepared") throw new Error("行动结果已保存在本机，等待同步，请重试连接");
      }
      this.status = this.control && this.world ? "ready" : "needs-initialization";
      this.updateLoadProgress({
        phase: "complete", active: false,
        totalComments: this.loadProgress?.readComments || 0
      });
      this.lastSyncAt = this.now();
      this.saveCache();
      if (fullScan || previousControlId !== String(this.control?.id || "")) {
        this.diagnostic({ event: "sync-completed", fullScan: Boolean(fullScan), status: this.status, history: { ...this.history }, controlId: this.control?.id || null, programHash: this.control?.programHash || null });
      }
      this.notify();
      return this.state();
    } catch (error) {
      if (this.syncPaused) {
        this.status = "closed";
        return this.state();
      }
      this.error = error?.message || String(error);
      this.updateLoadProgress({ phase: "error", error: this.error });
      this.status = this.world ? "degraded" : "error";
      this.diagnostic({ event: "sync-failed", fullScan: Boolean(fullScan), status: this.status, error: this.error, history: { ...this.history } });
      this.notify();
      throw error;
    } finally {
      this.syncing = false;
      this.commentReadSession = null;
      this.notify();
    }
  }

  applyJoinPreferences(intent = {}) {
    const orientation = ["men", "women", "any"].includes(String(intent.orientation || ""))
      ? String(intent.orientation)
      : this.pendingJoin?.orientation;
    this.localPreferences.orientation = orientation;
    this.localPreferences.characterProfileId = String(intent.characterProfileId || "").slice(0, 100);
    this.localPreferences.characterTags = normalizedCharacterTags(intent.characterTags);
    this.localPreferences.initialGeneralWish = String(intent.initialGeneralWish || "").slice(0, 500);
    this.localPreferences.characterProfile = normalizeCharacterProfile(intent.characterProfile || { id: intent.characterProfileId, displayName: intent.displayName });
    return { ...intent, orientation };
  }

  async prepareJoin(intent, account) {
    if (this.world.players?.[account.accountId]) return { duplicate: true, restored: true, state: this.state() };
    const normalized = this.applyJoinPreferences(intent);
    const contextSignature = sha256(Buffer.from(canonicalJson({
      accountId: account.accountId,
      characterProfile: this.localPreferences.characterProfile
    })));
    const playerContext = playerContextFromProfile(this.localPreferences.characterProfile);
    this.localPreferences.playerContext = cloneJson(playerContext);
    const previewId = crypto.randomUUID();
    const joinIntent = {
      type: "join",
      displayName: String(normalized.displayName || this.pendingJoin?.displayName || account.username || "玩家").slice(0, 40),
      characterProfileId: this.localPreferences.characterProfileId,
      orientation: this.localPreferences.orientation,
      characterTags: cloneJson(this.localPreferences.characterTags),
      initialGeneralWish: this.localPreferences.initialGeneralWish,
      playerContext: cloneJson(playerContext),
      idempotencyKey: `preview:${previewId}`
    };
    const previewOutcome = applyIntent(this.world, joinIntent, {
      actorAccountId: account.accountId,
      actorAccountName: account.username,
      authorityAccountId: this.control.authorityAccountId,
      now: this.now()
    });
    const effect = previewOutcome.effects.find(item => item.type === "general-generation-request" && item.initial);
    if (!effect) throw new Error("没有建立初始将领生成任务");
    const request = buildGeneralGenerationRequest(previewOutcome.state, effect, `preview-general:${previewId}`);
    const parsed = await this.requestStructuredModel(request, {
      attempts: 3,
      manualRetry: true,
      label: "初始将领生成",
      validate: value => generalGenerationQualityIssue(value, effect)
    });
    const seededEffect = { ...effect, generatedSeed: this.world.seed };
    const general = normalizeGeneratedGeneral(parsed, seededEffect);
    this.pendingJoinPreview = {
      previewId,
      accountId: account.accountId,
      contextSignature,
      playerContext: cloneJson(playerContext),
      joinIntent,
      effect: cloneJson(seededEffect),
      general: cloneJson(general),
      createdAt: this.now()
    };
    this.saveCache();
    return { joinPreview: { previewId, general: cloneJson(general) } };
  }

  async submitIntent(intent = {}) {
    this.diagnostic({
      event: "player-behavior-attempt",
      source: "local",
      accountId: this.account().accountId,
      behavior: cloneJson(intent)
    });
    if (this.migrationActive) throw new Error("游戏服务器正在搬迁，请稍后再试");
    if (this.pendingMigration?.workId && this.pendingMigration.workId !== this.work?.id) throw new Error("游戏服务器正在搬迁，请等待自动转入新服务器");
    if (String(intent.type || "") === "quote-march") {
      const accountId = this.account().accountId;
      if (!accountId || !this.world?.players?.[accountId]) throw new Error("请先加入在线游戏世界");
      if (this.world.bans?.[accountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁");
      const quote = marchQuote(cloneJson(this.world), accountId, intent.to, intent.soldiers, intent.generalIds, Boolean(intent.attack), this.now());
      return { marchQuote: quote };
    }
    if (this.syncInFlight) {
      try { await this.syncInFlight; }
      catch (error) { throw actionConnectionError(error); }
    } else if (this.status === "degraded") {
      try { await this.sync(false); }
      catch (error) { throw actionConnectionError(error); }
    }
    if (this.migrationActive) throw new Error("游戏服务器正在搬迁，请稍后再试");
    if (this.pendingMigration?.workId && this.pendingMigration.workId !== this.work?.id) throw new Error("游戏服务器正在搬迁，请等待自动转入新服务器");
    if (this.pendingIntentTransaction) {
      try { await this.sync(true); }
      catch (error) { throw actionConnectionError(error); }
      if (this.pendingIntentTransaction) throw new Error("上一项行动正在核对提交结果，请稍后再试");
    }
    if (["opening", "degraded", "error"].includes(this.status)) throw new Error("游戏暂时未连接，请稍后再试");
    const normalized = { ...intent, idempotencyKey: String(intent?.idempotencyKey || crypto.randomUUID()) };
    const key = `${String(normalized.type || "unknown")}:${normalized.idempotencyKey}`;
    if (this.intentInFlight) {
      if ((String(normalized.type || "") === "join" && this.intentInFlightKey.startsWith("join:")) || key === this.intentInFlightKey) return this.intentInFlight;
      throw new Error("上一项行动仍在处理中，请等待完成");
    }
    const running = this.submitIntentNow(normalized);
    this.intentInFlight = running;
    this.intentInFlightKey = key;
    if (String(normalized.type || "") === "join") this.joinInFlight = running;
    try {
      return await running;
    } catch (error) {
      throw actionConnectionError(error);
    } finally {
      if (this.joinInFlight === running) this.joinInFlight = null;
      if (this.intentInFlight === running) {
        this.intentInFlight = null;
        this.intentInFlightKey = "";
      }
    }
  }

  async submitIntentNow(intent = {}) {
    if (!this.control || !this.world) throw new Error("本赛季尚未初始化");
    const account = this.account();
    if (this.world?.bans?.[account.accountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁，所有游戏操作均会被忽略");
    if (this.recoverOwnLocalPlayerState()) this.saveCache();
    if (["join", "prepare-join"].includes(String(intent?.type || "")) && this.world.players?.[account.accountId]) {
      return { duplicate: true, restored: true, state: this.state() };
    }
    const normalized = { ...intent, idempotencyKey: String(intent.idempotencyKey || crypto.randomUUID()) };
    if (normalized.type === "world-chat") return this.submitWorldChat(normalized, account);
    if (normalized.type === "generate-general-letter") return this.generateGeneralLetter(normalized, account.accountId);
    const previousPreferences = cloneJson(this.localPreferences);
    if (normalized.type === "prepare-join") {
      try {
        return await this.prepareJoin(normalized, account);
      } catch (error) {
        this.localPreferences = previousPreferences;
        this.saveCache();
        throw error;
      }
    }
    if (normalized.type !== "join") return await this.applyLocalIntent(normalized, account.accountId);
    const pending = this.pendingJoinPreview;
    if (!pending || pending.accountId !== account.accountId || String(normalized.previewId || "") !== pending.previewId) {
      throw new Error("请先生成并查看初始将领，再点击确定进入游戏");
    }
    const preparedGeneral = normalizeGeneratedGeneral(pending.general, pending.effect, normalized.initialGeneral);
    const commitIntent = {
      ...cloneJson(pending.joinIntent),
      idempotencyKey: normalized.idempotencyKey
    };
    try {
      const result = await this.applyLocalIntent(commitIntent, account.accountId, {
        rollbackPreferences: previousPreferences,
        preparedGeneral,
        generatedGeneralPowerSeed: pending.effect.sourceId || pending.effect.discoveryId || pending.previewId
      });
      this.pendingJoinPreview = null;
      return result;
    } catch (error) {
      this.saveCache();
      throw error;
    }
  }

  sanitizedEvent(event) {
    if (event.type === "talk-general") return { ...event, result: { generalId: event.result.generalId, modelRequested: true } };
    if (event.type === "grant-general") return { ...event, result: {
      generalGranted: true, generalId: event.result.generalId,
      experience: event.result.experience, experienceRequired: event.result.experienceRequired,
      cultivationCount: event.result.cultivationCount
    } };
    return event;
  }

  async publishMapChanges(changes, identity, options = {}) {
    if (!hasPublicMapChanges(changes)) return null;
    const actor = this.world.players?.[this.account().accountId];
    const record = signRecord({
      schema: FYOW_SCHEMAS.mapDelta,
      mapDeltaId: String(options.mapDeltaId || crypto.randomUUID()),
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
    if (options.beforeWorld) {
      const validator = Object.create(this);
      validator.world = options.beforeWorld;
      const timestamp = Math.max(Math.trunc(this.now()), ...Object.values(changes.cellBases || {}).map(base => Number(base.order?.timestamp || 0) + 1));
      if (!validator.validMapDelta({ record, sources: [{ id: "local-preflight", account_id: record.actorAccountId, created_at: timestamp }] })) {
        this.diagnostic({ event: "map-delta-preflight-failed", code: "FYOW_MAP_DELTA_INVALID", mapDeltaId: record.mapDeltaId, cells: Object.keys(changes.cells || {}) });
        const error = new Error("行动同步校验未通过，请重新同步后重试（FYOW_MAP_DELTA_INVALID）");
        error.code = "FYOW_MAP_DELTA_INVALID";
        throw error;
      }
    }
    const sources = await this.postRecord(record);
    const order = recordPlatformOrder({ sources });
    this.lastPublishedMapOrder = { mapDeltaId: record.mapDeltaId, order: cloneJson(order) };
    const rootId = order.commentId || null;
    if (actor && rootId && !actor.commentRootId) actor.commentRootId = rootId;
    this.appliedMapDeltaIds.add(record.mapDeltaId);
    this.publicDeltaCountSinceSnapshot += 1;
    if (order.timestamp) {
      for (const key of Object.keys(changes.cells || {})) {
        this.publicCellOrders[key] = order;
        const envelope = occupationEnvelope(changes, key);
        if (envelope.modern) this.publicCellWriteBases[key] = occupationBaseDescriptor(envelope);
        else delete this.publicCellWriteBases[key];
      }
      for (const id of Object.keys(changes.generals || {})) {
        this.publicGeneralOrders[id] = order;
        this.localGeneralArchiveOrders[id] = order;
        const transition = changes.generalTransitions?.[id];
        if (transition?.reason === "recalled") {
          const previous = options.beforeWorld?.generals?.[id];
          this.publicGeneralRecalls[id] = {
            transition: cloneJson(transition), order: cloneJson(order), playerEpoch: record.playerEpoch,
            ...(previous?.status === "deployed" ? { general: publicGeneralState(previous) } : {})
          };
        }
      }
      for (const id of Object.keys(changes.marketListings || {})) this.publicMarketOrders[id] = order;
      for (const id of Object.keys(changes.marketSales || {})) this.publicMarketSaleOrders[id] = order;
      this.publicParticipantOrders[this.account().accountId] = order;
      if (compareOrderValue(order, this.publicMapOrder) > 0) this.publicMapOrder = order;
    }
    for (const [id, claim] of Object.entries(changes.claimedTreasures || {})) {
      this.world.claimedTreasures[id] = { ...cloneJson(claim), ...(order.timestamp ? { platformOrder: order } : {}) };
      delete this.world.treasureSpawns[id];
      const preferences = this.world.privatePlayers[this.account().accountId] ||= {};
      preferences.treasureClaimRewards ||= {};
      const pending = preferences.treasureClaimRewards[id] || {};
      preferences.treasureClaimRewards[id] = {
        ...pending, materialId: claim.materialId, status: "pending", amount: 1,
        credited: pending.credited !== false,
        mapDeltaId: record.mapDeltaId, platformOrder: order, scanFrom: pending.scanFrom || { ...this.publicMapBaselineOrder }
      };
    }
    this.rememberConquests(changes.conquests, order);
    return record;
  }

  async applyLocalIntent(intent, actorAccountId, options = {}) {
    if (String(actorAccountId) !== this.account().accountId) throw new Error("只能在本机执行当前玩家的行动");
    const actionTime = this.now();
    if (!options.internal) await this.settleLocalClock(actionTime);
    if (!options.internal && this.pendingIntentTransaction) throw new Error("上一项行动正在同步，请稍后重试");
    const identity = await this.getIdentity();
    bindWorldAuthority(this.world, this.control);
    const beforeWorld = cloneJson(this.world);
    const outcome = applyIntent(this.world, intent, {
      actorAccountId,
      actorAccountName: this.account().username,
      authorityAccountId: this.control.authorityAccountId,
      now: actionTime,
      experienceSince: this.experienceSessionStartedAt,
      requireExpectedMarchQuote: String(intent.type || "") === "march"
    });
    if (outcome.duplicate) return { duplicate: true, state: this.state() };
    this.world = outcome.state;
    this.holdTreasureRewards(beforeWorld);
    if (intent.type === "join") {
      const player = this.world.players[actorAccountId];
      player.accountName = this.account().username;
      player.deviceSigningPublicKey = identity.signingPublicKey;
      player.deviceEncryptionPublicKey = identity.encryptionPublicKey;
    }
    const localEvent = this.sanitizedEvent(outcome.event);
    const localEventStart = this.localEvents.length;
    this.recordLocalEvent(localEvent);
    let mapDelta = null;
    let transactionMapDeltaId = "";
    try {
      let dialogue = null;
      let deferredEffects = [];
      let effectsHandledEarly = false;
      if (outcome.result?.modelRequest) {
        if (String(outcome.result.modelRequest.task || "") === "general.appearance-edit") {
          dialogue = await this.completeAppearanceEdit(outcome.result.modelRequest, actorAccountId, intent);
        } else {
          dialogue = await this.completeDialogue(outcome.result.modelRequest, actorAccountId, intent);
        }
      }
      // Joining is a two-phase commit: the model result is previewed and may be
      // edited or rerolled before this branch creates the player and general.
      if (intent.type === "join" && options.preparedGeneral) {
        const effect = outcome.effects.find(item => item.type === "general-generation-request" && item.initial);
        if (!effect) throw new Error("初始将领确认任务缺少出生位置");
        const general = options.preparedGeneral;
        await this.applyLocalIntent({
          type: "grant-general",
          generalId: crypto.randomUUID(),
          discoveryId: `confirmed:${intent.idempotencyKey}`,
          name: general.name,
          gender: general.gender,
          heightCm: general.heightCm,
          weightKg: general.weightKg,
          measurements: cloneJson(general.measurements),
          appearanceSetting: general.appearanceSetting,
          coreSetting: general.coreSetting,
          location: { x: effect.x, y: effect.y },
          power: general.power,
          powerSeed: options.generatedGeneralPowerSeed || effect.sourceId || effect.discoveryId,
          generated: true,
          initial: true,
          idempotencyKey: `general:confirmed:${intent.idempotencyKey}`
        }, actorAccountId, { internal: true });
      } else if (intent.type === "join") {
        throw new Error("请先确认初始将领再进入游戏");
      }
      // A confirmed discovery is a point-consuming model operation. Generate
      // it before publishing the public delta so a failed request rolls back
      // the removed candidate and the UI can ask before every retry.
      if (outcome.effects.some(effect => effect.type === "general-generation-request" && effect.confirmed)) {
        const handled = await this.handleEffects(outcome.effects, identity, { deferOnFailure: false });
        deferredEffects = handled.deferred;
        effectsHandledEarly = true;
      }
      let farewell = null;
      if (outcome.result?.farewellRequest && !options.internal) {
        farewell = await this.completeFarewellLetter(outcome.result.farewellRequest, actorAccountId, intent);
        await this.applyLocalIntent({ type: "execute-captive", generalId: intent.generalId, allowFarewell: false, idempotencyKey: `execute-after-farewell:${intent.idempotencyKey}` }, actorAccountId, { internal: true });
      }
      const changes = attachCellBaseOrders(
        createPublicMapChanges(beforeWorld, this.world, outcome.effects, actorAccountId),
        this.publicCellOrders,
        this.publicMapBaselineOrder
      );
      transactionMapDeltaId = !options.internal && hasPublicMapChanges(changes) ? crypto.randomUUID() : "";
      if (transactionMapDeltaId) this.prepareIntentTransaction({
        beforeWorld,
        mapDeltaId: transactionMapDeltaId,
        intentType: intent.type,
        eventId: localEvent?.eventId,
        changes
      });
      mapDelta = options.internal ? null : await this.publishMapChanges(changes, identity, { mapDeltaId: transactionMapDeltaId, beforeWorld });
      if (mapDelta && this.pendingIntentTransaction?.mapDeltaId === mapDelta.mapDeltaId) {
        this.pendingIntentTransaction.phase = "published";
        this.pendingIntentTransaction.publishedAt = this.now();
        if (this.lastPublishedMapOrder?.mapDeltaId === mapDelta.mapDeltaId) {
          this.pendingIntentTransaction.publishedOrder = cloneJson(this.lastPublishedMapOrder.order);
        }
        this.saveCache();
      }
      if (intent.type !== "join" && !effectsHandledEarly) {
        const handled = await this.handleEffects(outcome.effects, identity, { deferOnFailure: Boolean(mapDelta) });
        deferredEffects = handled.deferred;
      }
      let snapshotWarning = null;
      if (!options.internal && this.isAuthority() && this.publicDeltaCountSinceSnapshot >= PUBLIC_LEDGER_COMPACTION_DELTAS) {
        try { await this.publishSnapshot(); } catch (error) { snapshotWarning = String(error?.message || error || "公共地图快照整理失败"); }
      }
      if (!options.internal) {
        if (!transactionMapDeltaId || this.pendingIntentTransaction?.mapDeltaId === transactionMapDeltaId) this.pendingIntentTransaction = null;
        this.saveCache();
        this.notify();
      }
      return { event: localEvent, mapDelta, effects: outcome.effects, deferredEffects, snapshotWarning, dialogue, farewell, state: this.state() };
    } catch (error) {
      if (!mapDelta) {
        if (transactionMapDeltaId && this.pendingIntentTransaction?.mapDeltaId === transactionMapDeltaId) this.pendingIntentTransaction = null;
        this.world = beforeWorld;
        if (options.rollbackPreferences) this.localPreferences = cloneJson(options.rollbackPreferences);
        this.localEvents.splice(localEventStart);
        if (!options.internal) {
          this.saveCache();
          this.notify();
        }
      }
      throw error;
    }
  }

  async settleLocalClock(nowValue = this.now(), { localOnly = false } = {}) {
    if (!this.world || this.pendingIntentTransaction) return [];
    const beforeWorld = cloneJson(this.world);
    const settled = settleWorld(this.world, nowValue, {
      activeAccountId: this.account().accountId,
      experienceSince: this.experienceSessionStartedAt,
      localOnly
    });
    if (!settled.effects.length) return [];
    const changes = attachCellBaseOrders(
      createPublicMapChanges(beforeWorld, settled.state, settled.effects, this.account().accountId),
      this.publicCellOrders,
      this.publicMapBaselineOrder
    );
    if (localOnly && hasPublicMapChanges(changes)) return [];
    this.world = normalizeWorldState(settled.state);
    this.holdTreasureRewards(beforeWorld);
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
    const localEventStart = this.localEvents.length;
    this.recordLocalEvent(event);
    const identity = await this.getIdentity();
    let mapDelta = null;
    let transactionMapDeltaId = "";
    try {
      transactionMapDeltaId = hasPublicMapChanges(changes) ? crypto.randomUUID() : "";
      if (transactionMapDeltaId) this.prepareIntentTransaction({
        beforeWorld,
        mapDeltaId: transactionMapDeltaId,
        intentType: "time-settle",
        eventId: event.eventId,
        changes
      });
      mapDelta = await this.publishMapChanges(changes, identity, { mapDeltaId: transactionMapDeltaId, beforeWorld });
      if (mapDelta && this.pendingIntentTransaction?.mapDeltaId === mapDelta.mapDeltaId) {
        this.pendingIntentTransaction.phase = "published";
        this.pendingIntentTransaction.publishedAt = this.now();
        if (this.lastPublishedMapOrder?.mapDeltaId === mapDelta.mapDeltaId) {
          this.pendingIntentTransaction.publishedOrder = cloneJson(this.lastPublishedMapOrder.order);
        }
        this.saveCache();
      }
      await this.handleEffects(settled.effects, identity, { deferOnFailure: Boolean(mapDelta) });
      if (!transactionMapDeltaId || this.pendingIntentTransaction?.mapDeltaId === transactionMapDeltaId) this.pendingIntentTransaction = null;
      this.saveCache();
      return settled.effects;
    } catch (error) {
      if (!mapDelta && transactionMapDeltaId && this.pendingIntentTransaction?.mapDeltaId === transactionMapDeltaId) {
        this.status = "degraded";
        this.error = "行动结果已保存在本机，等待同步，请重试连接";
        this.diagnostic({
          event: "intent-transaction-publish-deferred",
          status: "local-state-preserved",
          transactionId: this.pendingIntentTransaction.transactionId,
          mapDeltaId: transactionMapDeltaId,
          intentType: "time-settle",
          error: error?.message || String(error)
        });
        this.saveCache();
        this.notify();
        return settled.effects;
      }
      if (!mapDelta) {
        this.world = beforeWorld;
        this.localEvents.splice(localEventStart);
        this.saveCache();
      }
      throw error;
    }
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
    this.diagnostic({ event: "player-behavior", source: "local", behavior: { type: "update-preferences", orientation, characterTags } });
    if (this.world.privatePlayers?.[accountId]) {
      this.world.privatePlayers[accountId].orientation = orientation;
      this.world.privatePlayers[accountId].characterTags = [...characterTags];
    }
    this.saveCache();
    this.notify();
    return this.state();
  }

  async ensureLocalPlayerContext() {
    const accountId = this.account().accountId;
    if (!this.world?.players?.[accountId] || !this.localPreferences.characterProfile) return null;
    const context = playerContextFromProfile(this.localPreferences.characterProfile);
    this.localPreferences.playerContext = context;
    this.world.privatePlayers[accountId] ||= {};
    this.world.privatePlayers[accountId].playerContext = cloneJson(context);
    this.saveCache();
    this.notify();
    return context;
  }

  async requestStructuredModel(request, { attempts = 2, label = "模型请求", validate = null, manualRetry = false } = {}) {
    const attemptLimit = manualRetry ? 1 : Math.max(1, Number(attempts) || 1);
    const taskKey = String(request?.task || "model").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toUpperCase() || "MODEL";
    const errorCode = `MODEL_${taskKey}_001`;
    const oneAttempt = async ({ attempt = 1, signal } = {}) => {
      let usageRecorded = false;
      try {
        const freshRequest = { ...request };
        delete freshRequest.conversationId;
        delete freshRequest.conversation_id;
        const answer = await this.requestModel(freshRequest, { signal });
        this.recordModelUsage({ request: freshRequest, label, attempt, result: answer, status: "completed" });
        usageRecorded = true;
        const conversationId = String(answer?.conversationId || answer?.conversation_id || "").trim();
        if (!conversationId) throw new Error("平台没有返回新会话编号");
        if (this.modelConversationIds.has(conversationId)) throw new Error("平台复用了已经使用过的模型会话");
        this.modelConversationIds.add(conversationId);
        const parsed = parseJsonAnswer(answer?.answer ?? answer);
        const issue = typeof validate === "function" ? validate(parsed) : null;
        if (issue) throw new Error(String(issue));
        return parsed;
      } catch (error) {
        if (!usageRecorded && error?.modelUsage) this.recordModelUsage({ request, label, attempt, error, status: "failed" });
        this.diagnostic({ event: "model-structured-attempt-failed", task: String(request?.task || "unknown"), label, attempt, error: error?.message || String(error) });
        throw error;
      }
    };
    let structuredAttempts = 0;
    if (this.runModelTask) return this.runModelTask(label, async context => {
      structuredAttempts += 1;
      try {
        return await oneAttempt({ ...context, attempt: structuredAttempts });
      } catch (error) {
        if (structuredAttempts < attemptLimit) throw error;
        const terminal = new Error(`${label}未返回有效结构化结果：${error?.message || String(error)}`, { cause: error });
        terminal.retryable = Boolean(manualRetry);
        terminal.errorCode = errorCode;
        terminal.userMessage = `${label}生成失败`;
        throw terminal;
      }
    }, manualRetry ? { maxAttempts: 1 } : {});
    const run = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
        try {
          return await oneAttempt({ attempt });
        } catch (error) {
          lastError = error;
          if (attempt < attemptLimit) await new Promise(resolve => setTimeout(resolve, 350));
        }
      }
      const terminal = new Error(`${label}未返回有效结构化结果：${lastError?.message || String(lastError || "未知错误")}`);
      terminal.retryable = Boolean(manualRetry);
      terminal.errorCode = errorCode;
      terminal.userMessage = `${label}生成失败`;
      throw terminal;
    };
    const queued = this.modelRequestQueue.then(run, run);
    this.modelRequestQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  pendingTreasureRewards() {
    const preferences = this.world?.privatePlayers?.[this.account().accountId];
    return Object.entries(preferences?.treasureClaimRewards || {}).filter(([, reward]) => reward?.status === "pending");
  }

  holdTreasureRewards(beforeWorld) {
    const accountId = this.account().accountId;
    const preferences = this.world?.privatePlayers?.[accountId];
    if (!preferences) return;
    for (const [id, claim] of Object.entries(this.world.claimedTreasures || {})) {
      if (claim?.accountId !== accountId || beforeWorld?.claimedTreasures?.[id]) continue;
      const materialId = String(beforeWorld?.treasureSpawns?.[id]?.materialId || claim.materialId || "");
      if (!MATERIAL_BY_ID[materialId]) continue;
      preferences.treasureClaimRewards ||= {};
      preferences.treasureClaimRewards[id] = {
        materialId, amount: 1, status: "pending", scanFrom: { ...this.publicMapBaselineOrder },
        credited: true,
        playerEpoch: Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[accountId] || 0)))
      };
    }
  }

  reconcileTreasureRewards(history = null) {
    const accountId = this.account().accountId;
    const preferences = this.world?.privatePlayers?.[accountId];
    if (!preferences?.treasureClaimRewards) return;
    // Legacy rewards were already credited. Do not debit them merely because
    // an old comment is slow to read or has been compacted into a snapshot.
    for (const reward of Object.values(preferences.treasureClaimRewards)) {
      if (reward.status || reward.reconciled) continue;
      reward.status = "pending";
      reward.amount = 1;
      reward.credited = reward.credited !== false;
      reward.scanFrom = { timestamp: 0, commentId: "" };
    }
    if (!history?.confirmationComplete || history.assembled?.incomplete?.length || this.world.bans?.[accountId]?.banned) return;
    const candidates = (history.assembled?.records || []).filter(item => this.validMapDelta(item)).sort(comparePlatformOrder);
    for (const [id, reward] of this.pendingTreasureRewards()) {
      const matching = candidates.filter(item => item.record.changes?.claimedTreasures?.[id]);
      const ownPublished = matching.find(item => item.record.actorAccountId === accountId
        && (!reward.mapDeltaId || item.record.mapDeltaId === reward.mapDeltaId));
      const stored = this.world.claimedTreasures?.[id];
      const coveredClaim = stored?.platformOrder && compareOrderValue(stored.platformOrder, this.publicMapBaselineOrder) <= 0 ? stored : null;
      if (!ownPublished && !coveredClaim) continue;
      const earliest = matching[0];
      const claim = earliest?.record.changes.claimedTreasures[id] || coveredClaim;
      const order = earliest ? recordPlatformOrder(earliest) : coveredClaim.platformOrder;
      const current = this.world.claimedTreasures?.[id];
      const currentWins = current?.platformOrder && compareOrderValue(current.platformOrder, order) < 0;
      const winner = currentWins ? current : { ...cloneJson(claim), platformOrder: order };
      this.world.claimedTreasures[id] = winner;
      delete this.world.treasureSpawns[id];
      reward.status = winner.accountId === accountId ? "confirmed" : "rejected";
      reward.confirmedAt = this.now();
      if (reward.status === "confirmed") {
        if (!reward.credited) {
          preferences.materials ||= {};
          preferences.materials[reward.materialId] = Number(preferences.materials[reward.materialId] || 0) + Number(reward.amount || 1);
        }
        reward.credited = true;
      } else if (reward.credited) {
        preferences.materials ||= {};
        preferences.materials[reward.materialId] = Math.max(0, Number(preferences.materials[reward.materialId] || 0) - Number(reward.amount || 1));
        reward.credited = false;
      }
      if (reward.status === "rejected") for (const report of preferences.battleReports || []) {
        report.treasures = (report.treasures || []).filter(item => item.treasureId !== id);
      }
    }
  }

  async scatterPublicTreasures(options = {}) {
    if (!this.world || !this.control || !this.isAuthority() || this.account().accountId !== this.work?.authorAccountId) return null;
    const next = cloneJson(this.world);
    scatterTreasures(next, { count: options.count, redAscend: options.redAscend, redReroll: options.redReroll }, this.now());
    const identity = await this.getIdentity();
    if (identity.signingPublicKey !== this.control.authoritySigningPublicKey) throw new Error("当前设备不是本赛季登记的作者设备");
    const record = signRecord({
      schema: FYOW_SCHEMAS.authority,
      authorityId: crypto.randomUUID(),
      gameId: GRID_GAME_ID,
      workId: this.work.id,
      seasonId: this.control.seasonId,
      authorityAccountId: this.account().accountId,
      type: "treasure-scatter",
      treasureEpoch: next.treasureEpoch,
      treasureSpawns: cloneJson(next.treasureSpawns),
      issuedAt: this.now()
    }, identity.signingPrivateKey);
    const sources = await this.postRecord(record);
    if (!this.applyAuthorityDirective({ record, sources })) throw new Error("奇珍刷新记录发布后未通过作者身份与时间戳校验");
    await this.publishSnapshot();
    return record;
  }

  async administer(command = {}) {
    this.diagnostic({ event: "player-behavior-attempt", source: "authority", accountId: this.account().accountId, behavior: cloneJson(command) });
    if (this.migrationActive) throw new Error("游戏服务器正在搬迁，请稍后再试");
    if (this.pendingMigration?.workId && this.pendingMigration.workId !== this.work?.id) throw new Error("游戏服务器正在搬迁，请等待自动转入新服务器");
    if (this.syncInFlight) await this.syncInFlight;
    if (this.migrationActive) throw new Error("游戏服务器正在搬迁，请稍后再试");
    if (this.pendingMigration?.workId && this.pendingMigration.workId !== this.work?.id) throw new Error("游戏服务器正在搬迁，请等待自动转入新服务器");
    if (["opening", "degraded", "error"].includes(this.status)) throw new Error("游戏连接暂时不可用，请稍后再试");
    if (this.intentInFlight) throw new Error("上一项行动仍在处理中，请等待完成");
    const running = this.administerNow(command);
    this.intentInFlight = running;
    this.intentInFlightKey = `admin:${String(command.type || "")}`;
    try {
      return await running;
    } finally {
      if (this.intentInFlight === running) {
        this.intentInFlight = null;
        this.intentInFlightKey = "";
      }
    }
  }

  async administerNow(command = {}) {
    if (!this.work || !this.control || !this.world) throw new Error("请先开启在线游戏服务器");
    const account = this.account();
    if (!this.work.authorAccountId || account.accountId !== this.work.authorAccountId || !this.isAuthority()) throw new Error("服主指令仅对伴生作品作者开放");
    const type = String(command.type || "");
    if (["scatter-treasures", "treasure-scatter"].includes(type)) {
      const record = await this.scatterPublicTreasures(command);
      this.saveCache();
      this.notify();
      return { command: { type: "scatter-treasures", authorityId: record?.authorityId || null }, state: this.state() };
    }
    if (type === "simulate-player-intent") {
      const targetAccountId = String(command.targetAccountId || "").trim();
      const intent = command.intent && typeof command.intent === "object" && !Array.isArray(command.intent) ? cloneJson(command.intent) : {};
      if (!targetAccountId || !this.world.players?.[targetAccountId]) throw new Error("请选择已经加入本局的目标玩家");
      if (String(intent.type || "") !== "recall-general") throw new Error("这项特殊行动暂不支持代执行");
      const generalId = String(intent.generalId || "").trim();
      const general = this.world.generals?.[generalId];
      if (!general || general.status !== "deployed" || String(general.holderAccountId || "") !== targetAccountId || !validPosition(general.location)) throw new Error("目标玩家没有这名已部署将领");
      const cell = this.world.cells?.[`${general.location.x},${general.location.y}`];
      if (!cell || !(cell.generalIds || []).map(String).includes(generalId)) throw new Error("将领部署记录与所在区域不一致");
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
        playerEpoch: Math.max(0, Math.trunc(Number(this.world.playerEpochs?.[targetAccountId] || 0))),
        intent: { type: "recall-general", generalId },
        general: publicGeneralState(general),
        issuedAt: this.now()
      }, identity.signingPrivateKey);
      const sources = await this.postRecord(record);
      if (!this.applyAuthorityDirective({ record, sources })) throw new Error("代执行记录发布后未通过作者身份与时间戳校验");
      await this.publishSnapshot();
      this.saveCache();
      this.notify();
      return { command: { type, targetAccountId, intent: cloneJson(record.intent), authorityId }, state: this.state() };
    }
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
    this.saveCache();
    this.notify();
    return { command: { type, targetAccountId, authorityId }, state: this.state() };
  }

  async publishSnapshot() {
    const identity = await this.getIdentity();
    this.rememberTreasureSources(this.world.treasureSpawns);
    const through = ledgerOrder(this.publicHistoryOrder);
    for (const [id, source] of Object.entries(this.publicTreasureSources)) {
      if (source.retiredOrder && compareOrderValue(source.retiredOrder, through) <= 0) delete this.publicTreasureSources[id];
    }
    const state = projectWorldState(this.world, null, this.now());
    delete state.privatePlayers;
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
      ledgerCoverage: {
        version: 1,
        through,
        cellOrders: cloneJson(this.publicCellOrders),
        cellWriteBases: cloneJson(this.publicCellWriteBases),
        generalOrders: cloneJson(this.publicGeneralOrders),
        generalRecalls: cloneJson(this.publicGeneralRecalls),
        marketOrders: cloneJson(this.publicMarketOrders),
        marketSaleOrders: cloneJson(this.publicMarketSaleOrders),
        participantOrders: cloneJson(this.publicParticipantOrders),
        authorityOrders: cloneJson(this.publicAuthorityOrders),
        treasureSources: cloneJson(this.publicTreasureSources),
        appliedMapDeltaIds: [...this.appliedMapDeltaIds],
        appliedAuthorityIds: [...this.appliedAuthorityIds]
      },
      createdAt: this.now()
    }, identity.signingPrivateKey);
    const sources = await this.postRecord(snapshot);
    const order = recordPlatformOrder({ sources });
    if (order.timestamp) {
      this.publicMapOrder = order;
      this.publicMapBaselineOrder = through;
      this.publicDeltaCountSinceSnapshot = 0;
    }
    return snapshot;
  }

  effectKey(effect) {
    const accountId = String(effect?.accountId || "");
    const playerEpoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[accountId] || 0)));
    return sha256(Buffer.from(canonicalJson({ seasonId: this.control?.seasonId || "", playerEpoch, effect })));
  }

  deferModelEffect(effect, error) {
    const key = this.effectKey(effect);
    const existing = this.pendingModelEffects.find(item => item.key === key);
    const attempts = Math.max(1, Number(existing?.attempts || 0) + 1);
    const delay = Math.min(PENDING_EFFECT_RETRY_MAX_MS, PENDING_EFFECT_RETRY_BASE_MS * (2 ** Math.min(5, attempts - 1)));
    const next = {
      key,
      effect: cloneJson(effect),
      playerEpoch: Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[String(effect?.accountId || "")] || 0))),
      attempts,
      lastError: String(error?.message || error || "模型任务失败").slice(0, 300),
      nextAttemptAt: this.now() + delay
    };
    if (existing) Object.assign(existing, next);
    else this.pendingModelEffects.push(next);
    if (this.pendingModelEffects.length > 50) this.pendingModelEffects.splice(0, this.pendingModelEffects.length - 50);
    return next;
  }

  async retryPendingModelEffects(limit = 1) {
    if (!this.pendingModelEffects.length || !this.world || !this.control) return [];
    const pendingBeforePrune = this.pendingModelEffects.length;
    this.pendingModelEffects = this.pendingModelEffects.filter(item => {
      const accountId = String(item?.effect?.accountId || "");
      const playerEpoch = Math.max(0, Math.trunc(Number(this.world?.playerEpochs?.[accountId] || 0)));
      return Boolean(this.world.players?.[accountId]) && !this.world.bans?.[accountId]?.banned && playerEpoch === Math.max(0, Math.trunc(Number(item.playerEpoch || 0)));
    });
    if (this.pendingModelEffects.length !== pendingBeforePrune) this.saveCache();
    const due = this.pendingModelEffects.filter(item => Number(item.nextAttemptAt || 0) <= this.now()).slice(0, Math.max(1, limit));
    if (!due.length) return [];
    const identity = await this.getIdentity();
    const completed = [];
    for (const item of due) {
      try {
        await this.handleEffects([item.effect], identity);
        this.pendingModelEffects = this.pendingModelEffects.filter(candidate => candidate.key !== item.key);
        completed.push(item.key);
      } catch (error) {
        this.deferModelEffect(item.effect, error);
      }
    }
    this.saveCache();
    return completed;
  }

  async handleEffects(effects, identity, options = {}) {
    const completed = [];
    const deferred = [];
    for (const effect of effects || []) {
      if (effect.type !== "general-generation-request") continue;
      // Battle/training discovery only creates a local candidate. The model
      // call (and its point charge) starts after the player explicitly
      // confirms promotion. Initial join generation remains automatic because
      // it is already handled by the join preview/confirmation flow.
      if (!effect.initial && !effect.confirmed) continue;
      try {
        const effectKey = this.effectKey(effect);
        const request = buildGeneralGenerationRequest(this.world, effect, effectKey);
        const parsed = await this.requestStructuredModel(request, {
          attempts: 3,
          manualRetry: true,
          label: effect.initial ? "初始将领生成" : "将领生成",
          validate: value => generalGenerationQualityIssue(value, effect)
        });
        const seededEffect = { ...effect, generatedSeed: this.world.seed };
        const general = normalizeGeneratedGeneral(parsed, seededEffect);
        await this.applyLocalIntent({
          type: "grant-general",
          generalId: crypto.randomUUID(),
          discoveryId: effect.discoveryId || request.idempotencyKey,
          name: general.name,
          gender: general.gender,
          heightCm: general.heightCm,
          weightKg: general.weightKg,
          measurements: cloneJson(general.measurements),
          appearanceSetting: general.appearanceSetting,
          coreSetting: general.coreSetting,
          location: { x: effect.x, y: effect.y },
          power: general.power,
          powerSeed: effect.sourceId || effect.discoveryId || request.idempotencyKey,
          generated: true,
          initial: Boolean(effect.initial),
          idempotencyKey: `general:${request.idempotencyKey}`
        }, effect.accountId, { internal: true });
        completed.push(effectKey);
      } catch (error) {
        if (!options.deferOnFailure) throw error;
        deferred.push(this.deferModelEffect(effect, error));
      }
    }
    return { completed, deferred };
  }

 generalLetterRoutes(general, actorAccountId) {
   const seen = new Set();
    const ids = (general?.masterHistory || []).map(item => String(item.accountId || ""))
      .filter(id => id && id !== String(actorAccountId) && !seen.has(id) && seen.add(id));
    return ids.map((accountId, index) => ({
      recipientKey: "former-lord-" + (index + 1),
      accountId,
      displayName: String(this.world?.players?.[accountId]?.displayName || this.world?.bans?.[accountId]?.displayName || "前任主公")
    }));
  }

  async generateGeneralLetter(intent, actorAccountId) {
    const general = this.world?.generals?.[String(intent.generalId || "")];
    const player = this.world?.players?.[actorAccountId];
    if (!general || !player || general.holderAccountId !== actorAccountId) throw new Error("将领当前不归本机玩家保管");
    if (!["carried", "captured", "deployed"].includes(String(general.status || ""))) throw new Error("将领当前不可写信");
    const routes = this.generalLetterRoutes(general, actorAccountId);
    const targetKey = String(intent.recipientKey || "");
    const target = routes.find(item => item.recipientKey === targetKey || item.accountId === String(intent.recipientAccountId || ""));
    if (!target) throw new Error("书信目标不在将领经历记录中");
    const request = buildGeneralLetterRequest(this.world, general, player, {
      kind: String(intent.kind || "general").slice(0, 40),
      purpose: String(intent.purpose || "向收信人说明近况").slice(0, 300),
      guidance: String(intent.guidance || "").slice(0, 800),
      allowedRecipients: routes.filter(item => String(intent.kind || "general") === "farewell" ? true : item.recipientKey === target.recipientKey),
      idempotencyKey: `letter:${intent.idempotencyKey || crypto.randomUUID()}`
    }, this.now());
    try {
      const parsed = await this.requestStructuredModel(request, {
        attempts: 1,
        manualRetry: true,
        label: String(intent.kind || "general") === "farewell" ? "诀别信生成" : "将领书信生成",
        validate: value => letterQualityIssue(value, {
          allowedRecipientKeys: request.input.allowedRecipients.map(item => item.recipientKey),
          requiredRecipientKey: String(intent.kind || "general") === "farewell" ? "" : target.recipientKey
        })
      });
      const route = routes.find(item => item.recipientKey === String(parsed.recipientKey || "")) || target;
      const sent = await this.sendDirect(route.accountId, "general-letter", {
        generalId: general.id,
        generalName: general.name,
        text: String(parsed.text).trim(),
        purpose: request.input.purpose,
        kind: request.input.kind
      }, { fromLetterGeneration: true });
      this.saveCache();
      this.notify();
      return { letter: { recipientName: route.displayName, text: String(parsed.text).trim(), purpose: request.input.purpose, kind: request.input.kind }, direct: sent, state: this.state() };
    } catch (error) {
      if (error?.retryable === undefined) {
        error.retryable = true;
        error.errorCode ||= "MODEL_GENERAL_LETTER_001";
        error.userMessage ||= "将领书信生成失败";
      }
      throw error;
    }
  }

  async completeFarewellLetter(request, actorAccountId, intent) {
    const general = this.world?.generals?.[String(intent.generalId || "")];
    const player = this.world?.players?.[actorAccountId];
    if (!general || !player) throw new Error("诀别信将领不存在");
    const routes = Array.isArray(request?.routing?.recipients) ? request.routing.recipients : this.generalLetterRoutes(general, actorAccountId);
    try {
      const parsed = await this.requestStructuredModel(request, {
        attempts: 1,
        manualRetry: true,
        label: "诀别信生成",
        validate: value => letterQualityIssue(value, { allowedRecipientKeys: routes.map(item => String(item.recipientKey || "")) })
      });
      const route = routes.find(item => String(item.recipientKey || "") === String(parsed.recipientKey || ""));
      if (!route) throw new Error("诀别信没有选择有效收件人");
      const sent = await this.sendDirect(route.accountId, "general-letter", {
        generalId: general.id,
        generalName: general.name,
        text: String(parsed.text).trim(),
        purpose: String(request.input?.purpose || "诀别").slice(0, 300),
        kind: "farewell"
      }, { fromLetterGeneration: true });
      return { recipientName: route.displayName, text: String(parsed.text).trim(), direct: sent };
    } catch (error) {
      if (error?.retryable === undefined) {
        error.retryable = true;
        error.errorCode ||= "MODEL_FAREWELL_LETTER_001";
        error.userMessage ||= "诀别信生成失败";
      }
      throw error;
    }
  }

  async completeAppearanceEdit(request, actorAccountId, intent) {
    try {
      const parsed = await this.requestStructuredModel(request, {
        attempts: 1,
        manualRetry: true,
        label: "外观设定编辑",
        validate: appearanceQualityIssue
      });
      const applied = await this.applyLocalIntent({
        type: "apply-general-appearance",
        generalId: intent.generalId,
        appearanceSetting: parsed.appearanceSetting,
        idempotencyKey: `appearance-applied:${intent.idempotencyKey}`
      }, actorAccountId, { internal: true });
      return { appearanceSetting: parsed.appearanceSetting, state: applied.state };
    } catch (error) {
      if (error?.retryable === undefined) {
        error.retryable = true;
        error.errorCode ||= "MODEL_GENERAL_APPEARANCE_001";
        error.userMessage ||= "外观设定编辑失败";
      }
      throw error;
    }
  }

  async completeDialogue(request, actorAccountId, intent) {
    const general = this.world.generals?.[intent.generalId];
    const player = this.world.players?.[actorAccountId];
    const captive = general?.status === "captured" && general?.loyalToAccountId !== player?.accountId;
    const routes = Array.isArray(request?.routing?.formerLords) ? request.routing.formerLords : [];
    const allowedRecipientKeys = routes.map(item => String(item.recipientKey || "")).filter(Boolean);
    const parsed = await this.requestStructuredModel(request, {
      attempts: 2,
      manualRetry: true,
      label: captive ? "俘虏将领互动" : "普通将领互动",
      validate: value => combinedDialogueQualityIssue(value, { captive, allowedRecipientKeys })
    });
    const reply = compactDialogueReply(parsed.reply);
    const narration = String(parsed.narration || "").trim().slice(0, 600);
    const memory = parsed.memoryUpdate;
    const category = memory.category;
    const summary = String(memory.summary).trim();
    const emotion = String(memory.emotion).trim();
    const compactMemory = String(memory.compactMemory).trim();
    const intimacyDelta = Number(memory?.intimacyDelta);
    await this.applyLocalIntent({
      type: "record-general-dialogue",
      generalId: intent.generalId,
      topic: summary,
      userText: intent.topic,
      reply,
      narration,
      intimacyDelta,
      memoryUpdate: { category, summary, emotion, intimacyDelta, compactMemory },
      idempotencyKey: `dialogue:${intent.idempotencyKey}`
    }, actorAccountId, { internal: true });
    const command = parsed.command && typeof parsed.command === "object" ? parsed.command : null;
    if (command?.type === "surrender" && general?.status === "captured") {
      const surrendered = await this.applyLocalIntent({ type: "surrender-general", generalId: general.id, idempotencyKey: `surrender:${intent.idempotencyKey}` }, actorAccountId, { internal: true });
      const proposal = surrendered?.event?.result?.letterProposal;
      return {
        reply, narration,
        memory: { category, summary, emotion, intimacyDelta, compactMemory },
        intimacyDelta,
        command: { type: "surrender" },
        pendingAction: proposal ? {
          type: "letter", kind: "surrender", generalId: general.id,
          recipientAccountId: proposal.recipientAccountId,
          recipientName: proposal.recipientName,
          purpose: proposal.purpose,
          guidanceRequired: true
        } : null
      };
    } else if (command?.type === "send-letter") {
      const route = routes.find(item => String(item.recipientKey || "") === String(command.recipientKey || ""));
      if (!route) throw new Error("将领书信目标不在历任主公名单中");
      const routeDisplayName = String(route.displayName || this.world?.players?.[route.accountId]?.displayName || this.world?.bans?.[route.accountId]?.displayName || "前任主公");
      return {
        reply,
        narration,
        memory: { category, summary, emotion, intimacyDelta, compactMemory },
        intimacyDelta,
        command: { type: "send-letter" },
        pendingAction: {
          type: "letter", kind: "general", generalId: general.id,
          recipientKey: String(route.recipientKey), recipientAccountId: String(route.accountId),
          recipientName: routeDisplayName,
          purpose: String(command.purpose || command.text || "向前任主公说明近况").slice(0, 300),
          guidance: String(command.guidance || "").slice(0, 800), guidanceRequired: false
        }
      };
    } else if (command?.type === "appearance-change") {
      return {
        reply, narration,
        memory: { category, summary, emotion, intimacyDelta, compactMemory },
        intimacyDelta,
        command: { type: "appearance-change" },
        pendingAction: { type: "appearance", generalId: general.id, note: String(command.note || "").slice(0, 1000) }
      };
    }
    return { reply, narration, memory: { category, summary, emotion, intimacyDelta, compactMemory }, intimacyDelta, command: command ? { type: command.type } : null, commandResult: null };
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
    this.diagnostic({
      event: "player-behavior-attempt",
      source: "local-direct",
      accountId: this.account().accountId,
      behavior: { type: String(type || ""), toAccountId: String(toAccountId || ""), payload: cloneJson(payload || {}) }
    });
    if (!this.control || !this.world) throw new Error("本赛季尚未初始化");
    const sender = this.account();
    if (this.world.bans?.[sender.accountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁，书信指令会被忽略");
    const recipient = String(toAccountId || "");
    if (!recipient || recipient === sender.accountId) throw new Error("请选择另一名在线世界玩家");
    const messageType = String(type || "");
    if (!options.fromGeneralDialogue && !options.fromLetterGeneration) throw new Error("将领书信必须由互动结果触发");
    if (messageType !== "general-letter") throw new Error("书信只能由将领互动触发");
    const text = String(payload?.text || "").trim().slice(0, 1000);
    if (!text) throw new Error("消息正文不能为空");
    const general = this.world.generals?.[String(payload?.generalId || "")];
    if (!general || general.holderAccountId !== sender.accountId) throw new Error("将领当前不归本机玩家保管");
    const player = this.world.players?.[sender.accountId];
    const interactable = general.status === "captured" || player?.carriedGeneralIds?.includes(general.id)
      || (general.status === "deployed" && general.location?.x === player?.position?.x && general.location?.y === player?.position?.y);
    if (!interactable) throw new Error("将领当前不在可交互位置");
    const formerLords = new Set((general.masterHistory || []).map(item => String(item.accountId || "")).filter(id => id && id !== sender.accountId));
    if (!formerLords.has(recipient)) throw new Error("将领只能写信给记录中存在过的主公");
    const normalizedPayload = {
      generalId: general.id, generalName: general.name, text,
      purpose: String(payload?.purpose || "").trim().slice(0, 300),
      kind: String(payload?.kind || "general").trim().slice(0, 40)
    };
    const target = this.world.players[String(toAccountId)];
    if (!target?.deviceEncryptionPublicKey || !target?.commentRootId) throw new Error("接收方尚未登记通讯密钥或评论入口");
    this.consumeDirectSendBudget();
    const identity = await this.getIdentity();
    const messageId = crypto.randomUUID();
    const controlId = String(this.control.id || "");
    const context = `${this.work.id}/${this.control.seasonId}/${messageId}`;
    const direct = signRecord({ schema: FYOW_SCHEMAS.direct, messageId, gameId: GRID_GAME_ID, workId: this.work.id, seasonId: this.control.seasonId, ...(controlId ? { controlId } : {}), fromAccountId: sender.accountId, toAccountId: recipient, type: messageType, box: sealJson(normalizedPayload, target.deviceEncryptionPublicKey, context), createdAt: this.now() }, identity.signingPrivateKey);
    const wake = signRecord({ schema: FYOW_SCHEMAS.directWake, messageId, gameId: GRID_GAME_ID, workId: this.work.id, seasonId: this.control.seasonId, ...(controlId ? { controlId } : {}), fromAccountId: sender.accountId, toAccountId: recipient, createdAt: this.now() }, identity.signingPrivateKey);
    await this.postRecord(wake, { parentId: target.commentRootId, toAccountId: String(toAccountId) });
    const chat = await this.ensurePrivateChat(toAccountId);
    const chunks = encodeCommentRecord(direct);
    for (const content of chunks) await this.retryPlatformWrite(() => this.requestConsole("/chats/messages", { method: "POST", body: { chat_id: chat.id, content }, timeout: 20000 }));
    const sentItem = {
      messageId, direction: "out", gameId: GRID_GAME_ID, workId: this.work.id,
      seasonId: this.control.seasonId, controlId, toAccountId: recipient, type: messageType,
      payload: cloneJson(normalizedPayload), createdAt: direct.createdAt, sentAt: this.now()
    };
    this.directHistory.push(sentItem);
    if (this.directHistory.length > 200) this.directHistory.splice(0, this.directHistory.length - 200);
    this.diagnostic({ event: "player-behavior", source: "local-direct", behavior: cloneJson(sentItem) });
    this.saveCache();
    return { messageId, announced: true, sent: true, chunks: chunks.length };
  }

  async receiveDirectWakes() {
    if (!this.control || !this.world) return [];
    this.assertSyncActive();
    const accountId = this.account().accountId;
    const rootId = this.world.players?.[accountId]?.commentRootId;
    if (!rootId) return [];
    const branches = await this.readCommentBranches(rootId);
    const assembledWakes = assembleCommentRecords(branches);
    const wakes = assembledWakes.records
      .map(item => item.record)
      .filter(record => record?.schema === FYOW_SCHEMAS.directWake && record.toAccountId === accountId && this.directItemMatchesSession(record))
      .filter(record => !this.world.bans?.[record.fromAccountId]?.banned)
      .filter(record => {
        const senderKey = this.world.players?.[record.fromAccountId]?.deviceSigningPublicKey;
        return senderKey && verifySignedRecord(record, senderKey);
      })
      .filter(record => !this.seenDirectMessageIds.has(record.messageId));
    const received = [];
    const identity = wakes.length ? await this.getIdentity() : null;
    for (const wake of wakes) {
      this.assertSyncActive();
      if (!this.consumeDirectReceiveBudget(wake.fromAccountId)) {
        continue;
      }
      const chat = await this.findPrivateChat(wake.fromAccountId);
      this.assertSyncActive();
      if (!chat) continue;
      const messages = await this.requestConsole(`/chats/messages?chat_id=${encodeURIComponent(chat.id)}&page=1&limit=500`, { timeout: 15000 });
      this.assertSyncActive();
      const directs = assembleCommentRecords(extractContentItems(messages)).records
        .map(item => item.record)
        .filter(record => record?.schema === FYOW_SCHEMAS.direct && record.messageId === wake.messageId && record.fromAccountId === wake.fromAccountId && record.toAccountId === accountId)
        .filter(record => this.directItemMatchesSession(record))
        .filter(record => verifySignedRecord(record, this.world.players[wake.fromAccountId].deviceSigningPublicKey));
      const direct = directs[0];
      if (!direct) continue;
      try {
        const context = `${this.work.id}/${this.control.seasonId}/${direct.messageId}`;
        let payload;
        try {
          payload = openSealedJson(direct.box, identity.encryptionPrivateKey, context);
        } catch (error) {
          if (!direct.controlId) throw error;
          payload = openSealedJson(direct.box, identity.encryptionPrivateKey, `${this.work.id}/${this.control.seasonId}/${direct.controlId}/${direct.messageId}`);
        }
        const item = {
          messageId: direct.messageId, direction: "in", gameId: GRID_GAME_ID,
          workId: this.work.id, seasonId: this.control.seasonId, controlId: String(direct.controlId || this.control.id || ""),
          fromAccountId: direct.fromAccountId, type: direct.type, payload,
          createdAt: direct.createdAt, receivedAt: this.now()
        };
        this.directInbox.push(item);
        if (this.directInbox.length > 100) this.directInbox.splice(0, this.directInbox.length - 100);
        this.directHistory.push(item);
        if (this.directHistory.length > 200) this.directHistory.splice(0, this.directHistory.length - 200);
        this.seenDirectMessageIds.add(direct.messageId);
        received.push(item);
        this.diagnostic({ event: "player-behavior", source: "received-direct", behavior: cloneJson(item) });
      } catch {}
    }
    return received;
  }

  async verifyMigrationTargetLedger(draft, newWork, newControl, oldWork, oldControl, {
    allowRepair = true,
    attempts = 6,
    retryDelayMs = 250
  } = {}) {
    const activeWork = this.work;
    const activeControl = this.control;
    const activeRuntime = this.captureLedgerRuntimeState();
    const maxAttempts = Math.max(1, Math.min(12, Math.trunc(Number(attempts) || 1)));
    const verify = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          this.work = newWork;
          this.control = newControl;
          const comments = await this.readAllCommentSources();
          const records = assembleCommentRecords(comments).records;
          const control = this.verifiedControls(records)
            .find(item => String(item.record.id || "") === String(newControl.id || ""));
          const snapshot = this.verifiedSnapshots(records, newControl)
            .find(item => String(item.record.snapshotId || "") === String(draft.targetSnapshotId || ""));
          if (!control) throw new Error("新服务器控制记录尚未回读");
          if (!snapshot) throw new Error("新服务器初始快照尚未回读");
          if (String(activeWork?.id || "") === String(newWork.id)) {
            draft.targetLedgerRuntime = this.captureLedgerRuntimeState();
          }
          return { control, snapshot };
        } catch (error) {
          lastError = error;
          if (attempt + 1 < maxAttempts && retryDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
          }
        }
      }
      throw lastError || new Error("新服务器账本回读失败");
    };
    try {
      try {
        const verified = await verify();
        draft.targetLedgerVerified = true;
        this.saveMigrationDraftForSource(oldWork, oldControl);
        return verified;
      } catch (error) {
        if (!allowRepair) throw error;
        // Re-post the exact signed records. Duplicate chunks assemble to the
        // same record IDs, while a platform write that was acknowledged but
        // dropped can be repaired without creating a second server.
        this.work = newWork;
        this.control = newControl;
        await this.postRecord(newControl);
        draft.targetControlPosted = true;
        let snapshot = draft.targetSnapshot ? cloneJson(draft.targetSnapshot) : null;
        if (snapshot) await this.postRecord(snapshot);
        else {
          snapshot = await this.publishSnapshot();
          draft.targetSnapshot = cloneJson(snapshot);
          draft.targetSnapshotId = String(snapshot?.snapshotId || "");
        }
        draft.targetLedgerInitialized = true;
        draft.targetLedgerRuntime = this.captureLedgerRuntimeState();
        this.saveMigrationDraftForSource(oldWork, oldControl);
        const verified = await verify();
        draft.targetLedgerVerified = true;
        this.saveMigrationDraftForSource(oldWork, oldControl);
        return verified;
      }
    } finally {
      this.work = activeWork;
      this.control = activeControl;
      this.restoreLedgerRuntimeState(activeRuntime);
    }
  }

  async completeMigrationDraft(draft, oldWork, oldControl) {
    const identity = await this.getIdentity();
    if (identity.signingPublicKey !== oldControl.authoritySigningPublicKey) throw new Error("本机作者密钥与当前赛季权威密钥不一致");
    if (!draft.sourceLedgerRuntime) draft.sourceLedgerRuntime = this.captureLedgerRuntimeState();
    const sourceWorld = this.world;
    const newWork = {
      ...oldWork,
      id: String(draft.newWorkId),
      name: String(draft.targetName || oldWork.name),
      description: String(draft.targetDescription || oldWork.description || ""),
      url: String(draft.newWorkUrl || ""),
      authorAccountId: this.account().accountId
    };
    if (!draft.targetWorld) {
      const startedAt = this.now();
      const targetWorld = createWorld({
        seasonId: oldControl.seasonId,
        authorityAccountId: this.account().accountId,
        startedAt
      });
      scatterTreasures(targetWorld, {}, startedAt);
      draft.targetWorld = cloneJson(targetWorld);
      const targetControlUnsigned = {
        ...cloneJson(draft.targetControl),
        seasonId: targetWorld.seasonId,
        startedAt,
        updatedAt: startedAt
      };
      delete targetControlUnsigned.signature;
      draft.targetControl = signRecord(targetControlUnsigned, identity.signingPrivateKey);
      draft.targetLedgerInitialized = false;
      draft.targetLedgerVerified = false;
      draft.targetControlPosted = false;
      draft.targetSnapshot = null;
      draft.targetSnapshotId = "";
    }
    const newControl = cloneJson(draft.targetControl);
    if (!newControl?.id || String(newControl.workId || "") !== newWork.id) throw new Error("搬迁草稿中的目标控制记录无效");

    // Drafts created by the first 0.15.3 migration build were persisted only
    // after configuration import. Treat them as already imported so they can
    // resume without creating another target work.
    if (!draft.configuration && draft.configurationImported == null) {
      draft.configurationImported = true;
      draft.oldWorkRenameAttempted = true;
    }
    if (!draft.configurationImported) {
      try {
        const targetModelPayload = await this.requestGo(`/apps/config?app_id=${encodeURIComponent(newWork.id)}`, { timeout: 15000 });
        const targetModel = firstObject(targetModelPayload, item => typeof item.provider === "string"
          && typeof (item.name || item.model) === "string");
        if (!targetModel) throw new Error("平台没有返回新作品的模型配置");
        const targetPayload = modelConfigSavePayload(
          draft.configuration,
          newWork.id,
          newWork.name,
          newWork.description,
          targetModel
        );
        await this.retryPlatformWrite(() => this.requestConsole(`/apps/${encodeURIComponent(newWork.id)}/model-config`, {
          method: "POST",
          body: targetPayload,
          timeout: 30000
        }));
        const verifiedPayload = await this.retryPlatformWrite(() => this.requestConsole(
          `/apps/${encodeURIComponent(newWork.id)}/model-config/export`,
          { timeout: 30000 }
        ));
        if (!coreConfigMatches(exportedConfig(verifiedPayload), targetPayload)) throw new Error("新作品核心配置回读不一致");
        draft.configurationImported = true;
        this.saveMigrationDraftForSource(oldWork, oldControl);
      } catch (error) {
        this.work = oldWork;
        this.control = oldControl;
        this.pendingMigration = {
          workId: newWork.id,
          url: newWork.url,
          exportSha256: String(draft.exportSha256 || ""),
          configurationImported: false,
          oldWorkRenamed: Boolean(draft.oldWorkRenamed),
          requiresConfigurationImport: true,
          requiresPublish: true,
          redirectPublished: false,
          importError: String(error?.message || error)
        };
        this.saveCache();
        this.notify();
        return { ...this.pendingMigration };
      }
    }
    let targetSnapshot = draft.targetLedgerInitialized ? { snapshotId: String(draft.targetSnapshotId || "") } : null;
    try {
      if (!draft.targetLedgerInitialized) {
        this.work = newWork;
        this.control = newControl;
        this.world = normalizeWorldState(cloneJson(draft.targetWorld));
        bindWorldAuthority(this.world, this.control);
        this.publicMapOrder = { timestamp: 0, commentId: "" };
        this.publicMapBaselineOrder = { timestamp: 0, commentId: "" };
        this.publicHistoryOrder = { timestamp: 0, commentId: "" };
        this.publicCellOrders = {};
        this.publicCellWriteBases = {};
        this.publicGeneralOrders = {};
        this.publicGeneralRecalls = {};
        this.localGeneralArchiveOrders = {};
        this.publicMarketOrders = {};
        this.publicMarketSaleOrders = {};
        this.marketSettledSales.clear();
        this.publicParticipantOrders = {};
        this.publicAuthorityOrders = {};
        this.publicTreasureSources = {};
        this.appliedMapDeltaIds.clear();
        this.appliedAuthorityIds.clear();
        this.knownCommentIds.clear();
        this.historyTailPage = 1;
        this.historyPageOrder = "unknown";
        this.commentRootPages.clear();
        if (!draft.targetControlPosted) {
          await this.postRecord(newControl);
          draft.targetControlPosted = true;
          this.saveMigrationDraftForSource(oldWork, oldControl);
        }
        targetSnapshot = await this.publishSnapshot();
        draft.targetSnapshot = cloneJson(targetSnapshot);
        draft.targetSnapshotId = targetSnapshot?.snapshotId || "";
        draft.targetLedgerInitialized = true;
        draft.targetLedgerVerified = false;
        draft.targetLedgerRuntime = this.captureLedgerRuntimeState();
        this.saveMigrationDraftForSource(oldWork, oldControl);
      }
      await this.verifyMigrationTargetLedger(draft, newWork, newControl, oldWork, oldControl, {
        allowRepair: false,
        attempts: 2,
        retryDelayMs: 250
      });
    } catch (error) {
      this.work = oldWork;
      this.control = oldControl;
      this.world = sourceWorld;
      this.restoreLedgerRuntimeState(draft.sourceLedgerRuntime);
      this.pendingMigration = {
        workId: newWork.id,
        url: newWork.url,
        exportSha256: String(draft.exportSha256 || ""),
        configurationImported: Boolean(draft.configurationImported),
        oldWorkRenamed: Boolean(draft.oldWorkRenamed),
        newLedgerInitialized: Boolean(draft.targetLedgerInitialized),
        targetLedgerVerified: false,
        redirectPublished: false,
        requiresPublish: true,
        importError: String(error?.message || error)
      };
      this.saveCache();
      this.notify();
      return { ...this.pendingMigration };
    }
    this.work = oldWork;
    this.control = oldControl;
    this.world = sourceWorld;
    this.restoreLedgerRuntimeState(draft.sourceLedgerRuntime);
    const directive = draft.resetRecord || signRecord(createResetDirective({
      gameId: GRID_GAME_ID,
      seasonId: oldControl.seasonId,
      oldWorkId: oldWork.id,
      newWorkId: newWork.id,
      newWorkUrl: newWork.url,
      exportSha256: draft.exportSha256,
      migrationId: draft.migrationId,
      authorityAccountId: oldControl.authorityAccountId,
      authoritySigningPublicKey: oldControl.authoritySigningPublicKey,
      sourceControlId: oldControl.id,
      sourceProgramHash: oldControl.programHash,
      targetProgramHash: newControl.programHash,
      targetControlId: newControl.id,
      targetSnapshotId: targetSnapshot?.snapshotId || draft.targetSnapshotId || "",
      resetId: draft.resetId,
      issuedAt: draft.resetIssuedAt || this.now()
    }), identity.signingPrivateKey);
    if (!draft.resetPublished) {
      try {
        await this.postRecord(directive);
        draft.resetRecord = cloneJson(directive);
        draft.resetPublished = true;
        this.saveMigrationDraftForSource(oldWork, oldControl);
      } catch (error) {
        this.pendingMigration = {
          ...this.migrationStateFromReset({ record: directive }),
          configurationImported: Boolean(draft.configurationImported),
          oldWorkRenamed: Boolean(draft.oldWorkRenamed),
          newLedgerInitialized: true,
          redirectPublished: false,
          requiresPublish: true,
          importError: String(error?.message || error)
        };
        this.migrationDraft.targetSnapshotId = targetSnapshot?.snapshotId || draft.targetSnapshotId || "";
        this.saveCache();
        this.notify();
        return { ...this.pendingMigration };
      }
    }
    this.migrationDraft = null;
    this.saveCache();
    this.work = newWork;
    this.control = newControl;
    this.world = normalizeWorldState(cloneJson(draft.targetWorld));
    bindWorldAuthority(this.world, this.control);
    this.restoreLedgerRuntimeState(draft.targetLedgerRuntime);
    this.mapFactsCache = null;
    this.pendingMigration = {
      ...this.migrationStateFromReset({ record: directive }),
      configurationImported: Boolean(draft.configurationImported),
      oldWorkRenamed: Boolean(draft.oldWorkRenamed),
      targetLedgerVerified: true,
      redirectPublished: true,
      requiresConfigurationImport: false
    };
    this.saveCache();
    this.notify();
    return { ...this.pendingMigration };
  }

  async exportMigrationDraft() {
    if (this.migrationInFlight) return this.migrationInFlight;
    this.migrationActive = true;
    const running = (async () => {
      for (;;) {
        const active = [...new Set([this.syncInFlight, this.intentInFlight, this.joinInFlight].filter(Boolean))];
        if (!active.length) break;
        await Promise.allSettled(active);
      }
      return this.exportMigrationDraftNow();
    })();
    this.migrationInFlight = running;
    try {
      return await running;
    } finally {
      if (this.migrationInFlight === running) this.migrationInFlight = null;
      this.migrationActive = false;
    }
  }

  async exportMigrationDraftNow() {
    if (!this.isAuthority() || this.account().accountId !== this.work.authorAccountId) throw new Error("只有作品作者可以迁移游戏卡");
    const oldWork = this.work;
    const oldControl = this.control;
    if (!oldControl || !this.world || !this.isAuthority()) throw new Error("源服务器尚未完成权威校验");
    const draft = this.migrationDraft && String(this.migrationDraft.sourceWorkId || "") === String(oldWork.id)
      && String(this.migrationDraft.newWorkId || "")
      ? this.migrationDraft : null;
    if (draft) return this.completeMigrationDraft(draft, oldWork, oldControl);
    const embeddedConfiguration = this.card?.companion?.workId === oldWork.id
      && this.card?.program?.digest === this.currentProgramHash()
      && this.card?.companion?.configuration
      ? cloneJson(this.card.companion.configuration)
      : null;
    const exported = embeddedConfiguration || exportedConfig(
      await this.requestConsole(`/apps/${encodeURIComponent(this.work.id)}/model-config/export`, { timeout: 30000 })
    );
    const exportJson = canonicalJson(exported);
    const exportHash = sha256(Buffer.from(exportJson));
    const description = String(exported.desc || exported.descr || exported.dsc || exported.intro || exported.description || exported.app?.description || this.work.description || "");
    const identity = await this.getIdentity();
    if (identity.signingPublicKey !== oldControl.authoritySigningPublicKey) throw new Error("本机作者密钥与当前赛季权威密钥不一致");
    const created = await this.requestConsole("/apps", { method: "POST", body: { name: this.work.name, description, icon: "", icon_background: "", mode: "chat", type: 1 }, timeout: 30000 });
    const newWorkId = String(created?.data?.app?.id || created?.app?.id || created?.data?.id || created?.id || "");
    if (!newWorkId) throw new Error("平台没有返回新作品编号");
    const newWorkUrl = `${this.getOrigin().replace(/\/$/, "")}/zh/explore/installed/${encodeURIComponent(newWorkId)}`;
    const migrationId = crypto.randomUUID();
    const targetInstanceId = newWorkId.replace(/[^0-9a-z]/gi, "").slice(0, 16);
    const targetName = `${GRID_GAME_TITLE}[${targetInstanceId}]`;
    const newWork = { ...oldWork, id: newWorkId, name: targetName, description, url: newWorkUrl, authorAccountId: this.account().accountId };
    const newControlUnsigned = {
      ...oldControl,
      id: crypto.randomUUID(),
      workId: newWorkId,
      programHash: this.currentProgramHash(),
      migrationId,
      migrationSourceWorkId: oldWork.id,
      updatedAt: this.now()
    };
    delete newControlUnsigned.signature;
    const newControl = signRecord(newControlUnsigned, identity.signingPrivateKey);
    this.migrationDraft = {
      migrationId,
      sourceWorkId: oldWork.id,
      sourceControlId: oldControl.id,
      sourceSeasonId: oldControl.seasonId,
      sourceProgramHash: oldControl.programHash,
      sourceLedgerRuntime: this.captureLedgerRuntimeState(),
      newWorkId,
      newWorkUrl,
      targetName: newWork.name,
      targetDescription: newWork.description,
      exportSha256: exportHash,
      configuration: exported,
      configurationImported: false,
      oldWorkRenameAttempted: false,
      oldWorkRenamed: false,
      targetControl: newControl,
      targetControlPosted: false,
      targetSnapshot: null,
      targetSnapshotId: "",
      targetLedgerInitialized: false,
      targetLedgerVerified: false,
      resetId: crypto.randomUUID(),
      resetIssuedAt: this.now()
    };
    this.saveCache();
    return this.completeMigrationDraft(this.migrationDraft, oldWork, oldControl);
  }
}

module.exports = { OnlineWorldService, workReference, normalizeWorkDetail, bindWorldAuthority, commentAccountId, commentTimestamp, recordPlatformOrder, comparePlatformOrder, parseJsonAnswer, playerContextFromProfile, playerContextQualityIssue, generalGenerationQualityIssue, normalizeGeneratedGeneral, dialogueQualityIssue, combinedDialogueQualityIssue, letterQualityIssue, appearanceQualityIssue, compactDialogueReply, generalMemoryQualityIssue, HISTORY_PAGE_SIZE, MAX_HISTORY_PAGES };
