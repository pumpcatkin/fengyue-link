"use strict";
const { assertActive } = require("./auto-model-router.cjs");
const { messageId, findPreparedMessage, normalizeMessageText } = require("./platform-message-operations.cjs");

// state belongs to one account/work/room/round and is retained before dispatch.
async function preparePlatformTurn({ state, appId, conversationId, query, readRecords, requestModel, signal, onEvent = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assertActive(signal);
  if (state.input != null && normalizeMessageText(state.input) !== normalizeMessageText(query)) throw new Error("本轮输入发生变化，请先确认已有记录");
  state.input = query;
  state.conversationId ||= conversationId || null;
  if (!state.sent) {
    // Do not mistake an identical input from an earlier round for this request.
    state.baselineIds = state.conversationId ? (await readRecords(state.conversationId)).map(messageId) : [];
    assertActive(signal);
    state.sent = true;
    state.sentAt = Date.now();
    try {
      const result = await requestModel({ workId: appId, conversationId: state.conversationId, query, stopAfterTask: true, allowEmpty: true, signal,
        onEvent: detail => {
          state.taskId ||= detail.taskId || null;
          state.messageId ||= detail.messageId || null;
          if (detail.conversationId) {
            if (state.conversationId && state.conversationId !== detail.conversationId) state.identityMismatch = true;
            else state.conversationId = detail.conversationId;
          }
          if (detail.event === "stop-acknowledged") state.stopAcknowledged = true;
          if (detail.event === "stream-completed") state.ended = true;
          if (detail.event === "request-failed" || detail.event === "cancelled") state.streamClosed = true;
          onEvent(detail);
        } });
      state.conversationId = result.conversationId;
      state.messageId = result.messageId;
      state.ended = true;
      state.stopAcknowledged = Boolean(result.stopAcknowledged);
    } catch (error) {
      state.streamClosed = true;
      state.error = error.message;
      if (error.requestRejected && !state.messageId && !state.taskId) state.sent = false;
      throw error;
    }
  }
  assertActive(signal);
  if (state.identityMismatch) throw new Error("访客生成返回了其他会话，已停止后续写入");
  if (!state.ended && !(state.stopAcknowledged && state.streamClosed)) {
    throw Object.assign(new Error("本轮访客请求已发送，结束状态尚未确认；已保留请求编号，暂停重复生成"), { retryable: false });
  }
  if (!state.conversationId) throw new Error("本轮访客请求缺少服务端会话编号");
  for (let attempt = 1; attempt <= 8; attempt++) {
    const records = await readRecords(state.conversationId);
    const candidates = records.filter(record => !state.baselineIds?.includes(messageId(record)));
    const match = findPreparedMessage(candidates, { query, messageId: state.messageId });
    if (match) {
      state.messageId = messageId(match);
      state.createdAt = match.created_at ?? match.createdAt;
      state.ended = true;
      state.verified = true;
      return { sent: true, stopped: true, conversationId: state.conversationId, messageId: state.messageId,
        terminationMode: state.stopAcknowledged ? "server-stop-confirmed" : "server-completed", source: "platform-api" };
    }
    if (attempt < 8) await wait(350);
    assertActive(signal);
  }
  throw new Error("平台已接收本轮请求，消息回读尚未匹配；保留锚点并等待重查");
}
module.exports = { preparePlatformTurn };
