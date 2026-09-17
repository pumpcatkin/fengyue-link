const crypto = require("node:crypto");
const zlib = require("node:zlib");

const FYOW_WIRE_PREFIX = "§FYOW3§";
// Leave room for the platform's comment metadata and the continuation marker.
// Older FYOW3 roots were written as 1000-character comments and remain valid
// on read; new writes are deliberately kept below that historical ceiling.
const FYOW_COMMENT_LIMIT = 980;
const FYOW_CONTINUE_MARKER = "§CONTINUE§";
const FYOW_SCHEMAS = Object.freeze({
  control: "fyow.control/3",
  intent: "fyow.intent/3",
  event: "fyow.event/3",
  snapshot: "fyow.snapshot/3",
  mapDelta: "fyow.map-delta/1",
  privateVault: "fyow.private-vault/3",
  direct: "fyow.direct/3",
  directWake: "fyow.direct-wake/3",
  reset: "fyow.reset/3",
  authority: "fyow.authority/1",
  worldChat: "fyow.world-chat/1",
  generalDefinition: "fyow.general-definition/3",
  generalMemory: "fyow.general-memory/3"
});

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("FYOW 记录不能包含非有限数字");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
    }
    return result;
  }
  throw new Error(`FYOW 记录包含不支持的值：${typeof value}`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function recordId(record) {
  const candidate = record?.eventId || record?.snapshotId || record?.intentId || record?.messageId || record?.resetId || record?.id;
  const clean = String(candidate || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean || sha256(Buffer.from(canonicalJson(record))).slice(0, 32);
}

function recordKind(record) {
  const schema = String(record?.schema || "");
  if (schema === FYOW_SCHEMAS.control) return "CTRL";
  if (schema === FYOW_SCHEMAS.intent) return "INTENT";
  if (schema === FYOW_SCHEMAS.event) return "EVENT";
  if (schema === FYOW_SCHEMAS.snapshot) return "SNAP";
  if (schema === FYOW_SCHEMAS.mapDelta) return "MAP";
  if (schema === FYOW_SCHEMAS.privateVault) return "VAULT";
  if (schema === FYOW_SCHEMAS.direct) return "DIRECT";
  if (schema === FYOW_SCHEMAS.directWake) return "DMWAKE";
  if (schema === FYOW_SCHEMAS.reset) return "RESET";
  if (schema === FYOW_SCHEMAS.authority) return "AUTH";
  if (schema === FYOW_SCHEMAS.worldChat) return "WCHAT";
  if (schema === FYOW_SCHEMAS.generalDefinition) return "GDEF";
  if (schema === FYOW_SCHEMAS.generalMemory) return "GMEM";
  throw new Error(`未知 FYOW Schema：${schema || "空"}`);
}

function encodeCommentRecord(record, limit = FYOW_COMMENT_LIMIT) {
  const maximum = Math.max(300, Math.min(FYOW_COMMENT_LIMIT, Number(limit) || FYOW_COMMENT_LIMIT));
  const raw = Buffer.from(canonicalJson(record), "utf8");
  if (raw.length > 8 * 1024 * 1024) throw new Error("FYOW 记录超过 8 MiB 限制");
  const compressed = zlib.gzipSync(raw, { level: 9, mtime: 0 });
  const payload = compressed.toString("base64url");
  const digest = sha256(compressed);
  const kind = recordKind(record);
  const id = recordId(record);
  let chunkSize = maximum - 150;
  while (chunkSize >= 80) {
    const total = Math.max(1, Math.ceil(payload.length / chunkSize));
    if (total > 512) throw new Error("FYOW 记录超过 512 个评论分片限制");
    const parts = [];
    for (let index = 0; index < total; index += 1) {
      const body = payload.slice(index * chunkSize, (index + 1) * chunkSize);
      const continuation = index + 1 < total ? FYOW_CONTINUE_MARKER : "";
      parts.push(`${FYOW_WIRE_PREFIX}${kind}§${id}§${index + 1}/${total}§${digest}§${body}${continuation}`);
    }
    if (parts.every(part => part.length <= maximum)) return parts;
    chunkSize -= Math.max(16, Math.max(...parts.map(part => part.length - maximum)));
  }
  throw new Error("FYOW 记录头过长，不能放入评论");
}

function decodeCommentChunk(content) {
  const text = String(content || "");
  const index = text.indexOf(FYOW_WIRE_PREFIX);
  if (index < 0) return null;
  const match = text.slice(index).match(/^§FYOW3§([A-Z]+)§([A-Za-z0-9_-]{1,64})§(\d+)\/(\d+)§([a-f0-9]{64})§([A-Za-z0-9_-]+?)(§CONTINUE§)?$/);
  if (!match) return null;
  const part = Number(match[3]);
  const total = Number(match[4]);
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || part < 1 || total < 1 || part > total || total > 512) return null;
  return { kind: match[1], id: match[2], part, total, digest: match[5], payload: match[6], continued: match[7] ? true : null };
}

function chunkAuthorId(comment) {
  return String(comment?.account_id || comment?.accountId || comment?.created_by_account_id || comment?.from_account_id
    || comment?.account?.id || comment?.user?.id || comment?.author?.id || comment?.created_by?.id || comment?.sender?.id || "");
}

function chunkParentId(comment) {
  return String(comment?.parent_id || comment?.parentId || comment?.root_comment_id || comment?.rootCommentId || comment?._fyowRootId || "");
}

function assembleCommentRecords(comments) {
  const groups = new Map();
  const invalid = [];
  const decoded = [];
  const nativeParents = new Map();
  const allParts = new Map();
  for (const comment of comments || []) {
    const chunk = decodeCommentChunk(comment?.content);
    if (!chunk) continue;
    const baseKey = `${chunk.kind}:${chunk.id}:${chunk.total}:${chunk.digest}:${chunkAuthorId(comment)}`;
    const parentId = chunkParentId(comment);
    decoded.push({ comment, chunk, baseKey, parentId });
    if (!nativeParents.has(baseKey)) nativeParents.set(baseKey, new Set());
    if (parentId) nativeParents.get(baseKey).add(parentId);
    if (!allParts.has(baseKey)) allParts.set(baseKey, new Set());
    allParts.get(baseKey).add(chunk.part);
  }
  for (const { comment, chunk, baseKey, parentId } of decoded) {
    const id = String(comment?.id || comment?.comment_id || "");
    const branchId = parentId || (chunk.part === 1 && nativeParents.get(baseKey).has(id) ? id : "");
    const key = `${baseKey}:${branchId ? `branch:${branchId}` : "legacy"}`;
    if (!groups.has(key)) groups.set(key, { ...chunk, baseKey, parts: new Map(), sources: [], conflict: false });
    const group = groups.get(key);
    group.sources.push(comment);
    if (group.parts.has(chunk.part) && group.parts.get(chunk.part) !== chunk.payload) group.conflict = true;
    if (!group.parts.has(chunk.part)) group.parts.set(chunk.part, chunk.payload);
  }
  const records = [];
  const incomplete = [];
  const completedGroups = new Set();
  for (const [key, group] of groups) {
    if (group.parts.size !== group.total) {
      incomplete.push({ key, baseKey: group.baseKey, kind: group.kind, id: group.id, received: group.parts.size, total: group.total, sources: group.sources });
      continue;
    }
    try {
      if (group.conflict) throw new Error("同一分片内容冲突");
      const root = group.sources.find(source => decodeCommentChunk(source?.content)?.part === 1);
      const rootId = String(root?.id || root?.comment_id || "");
      const branchId = chunkParentId(root) || rootId;
      if (group.sources.some(source => {
        const parentId = chunkParentId(source);
        return parentId && parentId !== branchId;
      })) throw new Error("续接分片不属于原评论");
      const markerState = group.sources.map(source => decodeCommentChunk(source?.content)?.continued);
      const marked = markerState.some(value => value !== null);
      if (marked && group.sources.some(source => {
        const chunk = decodeCommentChunk(source?.content);
        return chunk && ((chunk.part < chunk.total && chunk.continued !== true) || (chunk.part === chunk.total && chunk.continued === true));
      })) throw new Error("续接标记不一致");
      const payload = Array.from({ length: group.total }, (_, index) => group.parts.get(index + 1) || "").join("");
      const compressed = Buffer.from(payload, "base64url");
      if (sha256(compressed) !== group.digest) throw new Error("摘要不一致");
      const record = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }).toString("utf8"));
      if (recordKind(record) !== group.kind || recordId(record) !== group.id) throw new Error("记录类型或编号与分片头不一致");
      records.push({ kind: group.kind, id: group.id, record, sources: group.sources, root });
      completedGroups.add(group.baseKey);
    } catch (error) {
      invalid.push({ key, kind: group.kind, id: group.id, error: error?.message || String(error) });
    }
  }
  const crossRootGroups = new Set();
  for (const item of incomplete) {
    if (!completedGroups.has(item.baseKey) && nativeParents.get(item.baseKey).size
      && allParts.get(item.baseKey).size === item.total && !crossRootGroups.has(item.baseKey)) {
      crossRootGroups.add(item.baseKey);
      invalid.push({ key: item.baseKey, kind: item.kind, id: item.id, error: "续接分片不属于原评论" });
    }
  }
  return {
    records,
    incomplete: incomplete.filter(item => !completedGroups.has(item.baseKey)).map(({ baseKey, ...item }) => item),
    invalid
  };
}

function extractCommentItems(payload) {
  const result = [];
  const seenObjects = new Set();
  const byId = new Map();
  const rootIds = new Set();
  const replyKeys = new Set(["children", "replies", "branches", "child_comments", "sub_comments"]);
  const envelopeKeys = new Set(["data", "items", "list", "rows", "comment", "comments", "results", "records", "result", "payload", "response", ...replyKeys]);
  const queue = [{ value: payload, depth: 0, branchId: "" }];
  // A full root page may contain hundreds of replies per root. Account/profile
  // metadata is deliberately not traversed: it is not another comment list.
  for (let cursor = 0; cursor < queue.length && seenObjects.size < 65536; cursor += 1) {
    const { value, depth, branchId } = queue[cursor];
    if (!value || typeof value !== "object" || seenObjects.has(value) || depth > 16) continue;
    seenObjects.add(value);
    const isComment = !Array.isArray(value) && typeof value.content === "string" && (value.id || value.comment_id);
    let childBranchId = branchId;
    if (isComment) {
      const id = String(value.id || value.comment_id);
      childBranchId ||= id;
      if (!branchId) rootIds.add(id);
      if (!byId.has(id)) {
        const comment = { ...value, ...(branchId ? { _fyowRootId: branchId } : {}) };
        byId.set(id, comment);
        result.push(comment);
      } else if (branchId) byId.get(id)._fyowRootId = branchId;
    }
    const entries = Array.isArray(value) ? value.map(child => ["", child]) : Object.entries(value);
    for (const [key, child] of entries) {
      if (!child || typeof child !== "object") continue;
      if (!Array.isArray(value) && !(isComment ? replyKeys : envelopeKeys).has(key)) continue;
      queue.push({ value: child, depth: depth + 1, branchId: isComment ? childBranchId : branchId });
    }
  }
  // Flattening replies must never change the number of platform pagination
  // items. Keep metadata non-enumerable so legacy array callers stay compatible.
  Object.defineProperties(result, {
    rootCount: { value: rootIds.size, enumerable: false },
    rootIds: { value: [...rootIds], enumerable: false }
  });
  return result;
}

function commentIsFromAuthor(comment) {
  return Boolean(
    comment?.is_author || comment?.isAuthor || comment?.author_badge || comment?.authorBadge
    || comment?.account?.is_author || comment?.account?.isAuthor || comment?.user?.is_author
  );
}

function newestCompleteSnapshot(assembled) {
  return (assembled?.records || [])
    .map(item => item.record)
    .filter(record => record?.schema === FYOW_SCHEMAS.snapshot && Number.isSafeInteger(Number(record.revision)))
    .sort((left, right) => Number(right.revision) - Number(left.revision))[0] || null;
}

function historyPageDecision({ pageComments = [], assembled, knownCommentIds = [], fullScan = true, requireControl = false } = {}) {
  const known = new Set((knownCommentIds || []).map(String));
  const hasKnownComment = pageComments.some(comment => known.has(String(comment?.id || comment?.comment_id || "")));
  if (!fullScan && hasKnownComment && !(assembled?.incomplete || []).length) {
    return { stop: true, reason: "known-comment-reached" };
  }
  if (!pageComments.length) return { stop: true, reason: "empty-page" };
  const snapshot = newestCompleteSnapshot(assembled);
  if (!snapshot || (assembled?.incomplete || []).length) return { stop: false, reason: "need-older-pages" };
  const controls = (assembled?.records || []).map(item => item.record).filter(record => record?.schema === FYOW_SCHEMAS.control);
  if (requireControl && !controls.some(record => !snapshot.seasonId || record.seasonId === snapshot.seasonId)) {
    return { stop: false, reason: "need-control-record", snapshotRevision: Number(snapshot.revision) };
  }
  return { stop: true, reason: "covered-by-snapshot", snapshotRevision: Number(snapshot.revision) };
}

function signRecord(record, privateKey) {
  const unsigned = { ...record };
  delete unsigned.signature;
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64url") };
}

function verifySignedRecord(record, publicKey) {
  if (!record?.signature) return false;
  const unsigned = { ...record };
  const signature = String(unsigned.signature);
  delete unsigned.signature;
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature, "base64url"));
  } catch { return false; }
}

function createResetDirective({ gameId, seasonId, oldWorkId, newWorkId, newWorkUrl, exportSha256, issuedAt = Date.now(), resetId = crypto.randomUUID() }) {
  return {
    schema: FYOW_SCHEMAS.reset,
    resetId,
    gameId: String(gameId),
    seasonId: String(seasonId),
    oldWorkId: String(oldWorkId),
    newWorkId: String(newWorkId),
    newWorkUrl: String(newWorkUrl),
    exportSha256: String(exportSha256),
    issuedAt: Number(issuedAt)
  };
}

module.exports = {
  FYOW_WIRE_PREFIX,
  FYOW_COMMENT_LIMIT,
  FYOW_CONTINUE_MARKER,
  FYOW_SCHEMAS,
  canonicalJson,
  sha256,
  encodeCommentRecord,
  decodeCommentChunk,
  assembleCommentRecords,
  extractCommentItems,
  commentIsFromAuthor,
  newestCompleteSnapshot,
  historyPageDecision,
  signRecord,
  verifySignedRecord,
  createResetDirective
};
