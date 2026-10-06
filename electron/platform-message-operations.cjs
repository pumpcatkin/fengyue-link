"use strict";

function normalizeMessageText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trimEnd();
}

function messageId(record) {
  return String(record?.id ?? record?.message_id ?? record?.messageId ?? "").trim();
}

function messageCreatedAt(record) {
  const value = record?.message_created_at ?? record?.messageCreatedAt ?? record?.created_at ?? record?.createdAt;
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recordTimestamp(record) {
  const createdAt = messageCreatedAt(record);
  if (createdAt != null) return createdAt;
  const value = record?.created_at ?? record?.createdAt ?? record?.updated_at ?? record?.updatedAt ?? 0;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMessageRecord(record) {
  return Boolean(record && typeof record === "object" && messageId(record)
    && (Object.prototype.hasOwnProperty.call(record, "query") || Object.prototype.hasOwnProperty.call(record, "answer")));
}

function latestMessageRecord(records, { requireAnswer = false } = {}) {
  return (Array.isArray(records) ? records : [])
    .filter(record => isMessageRecord(record) && (!requireAnswer || Object.prototype.hasOwnProperty.call(record, "answer")))
    .slice()
    .sort((left, right) => recordTimestamp(right) - recordTimestamp(left))[0] || null;
}

function findPreparedMessage(records, { query, messageId: expectedMessageId } = {}) {
  const expectedId = String(expectedMessageId || "").trim();
  const expectedQuery = normalizeMessageText(query);
  return (Array.isArray(records) ? records : [])
    .filter(record => isMessageRecord(record))
    .find(record => (!expectedId || messageId(record) === expectedId)
      && (!expectedQuery || normalizeMessageText(record.query) === expectedQuery)) || null;
}

function editMessageRequest(appId, id, answer) {
  if (!appId || !id) throw new Error("编辑记录缺少作品或消息编号");
  return {
    method: "PATCH",
    path: `/installed-apps/${encodeURIComponent(appId)}/messages/${encodeURIComponent(id)}`,
    body: { answer: String(answer ?? "") }
  };
}

function deleteMessageRequest(appId, id) {
  if (!appId || !id) throw new Error("删除记录缺少作品或消息编号");
  return {
    method: "DELETE",
    path: `/installed-apps/${encodeURIComponent(appId)}/messages/${encodeURIComponent(id)}`
  };
}

function readMessageRecords(payload, { strict = false } = {}) {
  const queue = [{ value: payload, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (Array.isArray(value) && value.every(isMessageRecord)) return value;
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 6) {
      for (const key of ["data", "messages", "items", "list", "result", "results"]) {
        if (value[key] != null) queue.push({ value: value[key], depth: depth + 1 });
      }
    }
  }
  if (strict) throw new Error("平台消息列表格式异常，尚未确认记录状态");
  return [];
}

async function mutatePlatformMessage(api, { appId, conversationId, id, action, answer }, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 12, signal, readRecord } = {}) {
  if (!["edit", "delete"].includes(action) || !conversationId || !appId || !id) throw new Error("记录操作参数无效");
  const read = readRecord ? async () => { const record = await readRecord(); return record ? [record] : []; }
    : async () => readMessageRecords(await api(`/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=100&page=1&paging_query_sort=desc`, { timeout: 10000, signal }), { strict: true });
  const matches = records => action === "delete" ? !records.some(item => messageId(item) === id)
    : records.some(item => messageId(item) === id && normalizeMessageText(item.answer) === normalizeMessageText(answer));
  const initial = await read();
  if (matches(initial)) return { verified: true, reused: true, messageId: id };
  if (!initial.some(item => messageId(item) === id)) throw new Error("指定会话中没有待编辑消息");
  const request = action === "edit" ? editMessageRequest(appId, id, answer) : deleteMessageRequest(appId, id);
  let failure;
  try { await api(request.path, { method: request.method, ...(request.body ? { body: request.body } : {}), timeout: 15000, signal }); }
  catch (error) { failure = error; if ([401, 403, 429].includes(error.status)) throw error; }
  // A lost write response is reconciled by reading the pinned ID, never by choosing another row.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error("操作已取消"), { name: "AbortError", retryable: false });
    try {
      if (matches(await read())) return { verified: true, messageId: id };
    } catch (error) { failure = error; }
    if (attempt < attempts) await wait(300);
  }
  throw Object.assign(new Error(`平台${action === "edit" ? "保存" : "删除"}记录尚未通过回读验证${failure ? `：${failure.message}` : ""}`), { retryable: false, messageId: id });
}

module.exports = {
  normalizeMessageText,
  messageId,
  messageCreatedAt,
  recordTimestamp,
  isMessageRecord,
  latestMessageRecord,
  findPreparedMessage,
  editMessageRequest,
  deleteMessageRequest,
  readMessageRecords,
  mutatePlatformMessage
};
