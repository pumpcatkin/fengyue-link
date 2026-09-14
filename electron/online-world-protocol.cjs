const crypto = require("node:crypto");
const zlib = require("node:zlib");

const FYOW_WIRE_PREFIX = "§FYOW3§";
const FYOW_COMMENT_LIMIT = 1000;
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
  if (schema === FYOW_SCHEMAS.generalDefinition) return "GDEF";
  if (schema === FYOW_SCHEMAS.generalMemory) return "GMEM";
  throw new Error(`未知 FYOW Schema：${schema || "空"}`);
}

function encodeCommentRecord(record, limit = FYOW_COMMENT_LIMIT) {
  const maximum = Math.max(300, Math.min(FYOW_COMMENT_LIMIT, Number(limit) || FYOW_COMMENT_LIMIT));
  const compressed = zlib.gzipSync(Buffer.from(canonicalJson(record), "utf8"), { level: 9, mtime: 0 });
  const payload = compressed.toString("base64url");
  const digest = sha256(compressed);
  const kind = recordKind(record);
  const id = recordId(record);
  let chunkSize = maximum - 150;
  while (chunkSize >= 80) {
    const total = Math.max(1, Math.ceil(payload.length / chunkSize));
    const parts = [];
    for (let index = 0; index < total; index += 1) {
      const body = payload.slice(index * chunkSize, (index + 1) * chunkSize);
      parts.push(`${FYOW_WIRE_PREFIX}${kind}§${id}§${index + 1}/${total}§${digest}§${body}`);
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
  const match = text.slice(index).match(/^§FYOW3§([A-Z]+)§([A-Za-z0-9_-]{1,64})§(\d+)\/(\d+)§([a-f0-9]{64})§([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const part = Number(match[3]);
  const total = Number(match[4]);
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || part < 1 || total < 1 || part > total || total > 512) return null;
  return { kind: match[1], id: match[2], part, total, digest: match[5], payload: match[6] };
}

function assembleCommentRecords(comments) {
  const groups = new Map();
  const invalid = [];
  for (const comment of comments || []) {
    const chunk = decodeCommentChunk(comment?.content);
    if (!chunk) continue;
    const key = `${chunk.kind}:${chunk.id}:${chunk.total}:${chunk.digest}`;
    if (!groups.has(key)) groups.set(key, { ...chunk, parts: new Map(), sources: [] });
    const group = groups.get(key);
    group.sources.push(comment);
    if (!group.parts.has(chunk.part)) group.parts.set(chunk.part, chunk.payload);
  }
  const records = [];
  const incomplete = [];
  for (const [key, group] of groups) {
    if (group.parts.size !== group.total) {
      incomplete.push({ key, kind: group.kind, id: group.id, received: group.parts.size, total: group.total });
      continue;
    }
    try {
      const payload = Array.from({ length: group.total }, (_, index) => group.parts.get(index + 1) || "").join("");
      const compressed = Buffer.from(payload, "base64url");
      if (sha256(compressed) !== group.digest) throw new Error("摘要不一致");
      const record = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }).toString("utf8"));
      records.push({ kind: group.kind, id: group.id, record, sources: group.sources });
    } catch (error) {
      invalid.push({ key, kind: group.kind, id: group.id, error: error?.message || String(error) });
    }
  }
  return { records, incomplete, invalid };
}

function extractCommentItems(payload) {
  const result = [];
  const seenObjects = new Set();
  const seenIds = new Set();
  const queue = [{ value: payload, depth: 0 }];
  while (queue.length && seenObjects.size < 1000) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seenObjects.has(value) || depth > 8) continue;
    seenObjects.add(value);
    if (!Array.isArray(value) && typeof value.content === "string" && (value.id || value.comment_id)) {
      const id = String(value.id || value.comment_id);
      if (!seenIds.has(id)) { seenIds.add(id); result.push(value); }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
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
