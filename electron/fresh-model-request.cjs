"use strict";
const { abortable, abortError, assertActive } = require("./auto-model-router.cjs");
const { consumeModelEventStream, createConversationModelRequestPayload } = require("./model-stream.cjs");
const { platformRequestError, isRateLimitMessage, retryAfterMs, RATE_LIMIT_MESSAGE } = require("./platform-transport.cjs");

async function requestPlatformModel({ fetch, origin, workId, query, files = [], headers, signal, onEvent = () => {},
  conversationId, messageId, createdAt, isRefresh = false, isUseRefreshCard, inputs = {}, stopAfterTask = false, allowEmpty = false }) {
  assertActive(signal);
  const controller = new AbortController();
  let useGo = true, taskId = null, completed = false, stopPromise = null, stopAcknowledged = false;
  let receivedConversationId = null, receivedMessageId = null;
  const emit = detail => { try { onEvent(detail); } catch {} };
  const installed = `/console/api/installed-apps/${encodeURIComponent(workId)}/chat-messages`;
  const request = { method: "POST", credentials: "include", cache: "no-store", headers,
    signal: controller.signal, body: JSON.stringify(createConversationModelRequestPayload({ workId, query, files, conversationId, messageId, createdAt, isRefresh, isUseRefreshCard, inputs })) };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      let go = useGo, failure;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const stopController = new AbortController();
        const timeout = setTimeout(() => stopController.abort(), 5000);
        try {
          const path = go ? "/go/api/apps/chat-stop" : `${installed}/${encodeURIComponent(taskId)}/stop`;
          const response = await abortable(() => fetch(new URL(path, origin).href, { method: "POST", credentials: "include", headers, signal: stopController.signal,
            ...(go ? { body: JSON.stringify({ task_id: taskId }) } : {}) }), stopController.signal);
          if (go && [404, 405].includes(response.status)) { go = false; continue; }
          const payload = response.status === 204 ? {} : await abortable(() => response.json(), stopController.signal);
          if (!response.ok || (payload.code != null && !["", "0", "100000"].includes(String(payload.code)))) {
            throw Object.assign(new Error(payload.message || payload.msg || `停止任务 HTTP ${response.status}`), { status: response.status });
          }
          stopAcknowledged = true;
          emit({ event: "stop-acknowledged", taskId, attempt });
          return true;
        } catch (error) {
          failure = error;
          if ([401, 403, 404, 405, 429].includes(error.status)) break;
        } finally { clearTimeout(timeout); }
      }
      emit({ event: "stop-unconfirmed", taskId, error: failure?.message || "停止路由未就绪" });
      return false;
    })();
    return stopPromise;
  };
  const cancel = () => {
    controller.abort();
    if (!completed && taskId) {
      emit({ event: "stop-requested", taskId });
      void stop();
    } else if (!completed) emit({ event: "stop-unconfirmed", taskId: null, reason: "task-id-not-yet-received" });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    emit({ event: "request-dispatched", newConversation: !conversationId, conversationId: conversationId || null });
    let response = await abortable(() => fetch(new URL("/go/api/apps/chat-messages", origin).href, request), signal);
    if ([404, 405].includes(response.status)) {
      useGo = false;
      await response.body?.cancel?.().catch(() => {});
      emit({ event: "endpoint-fallback", status: response.status });
      response = await abortable(() => fetch(new URL(installed, origin).href, request), signal);
    }
    emit({ event: "response-received", status: response.status });
    if (!response.ok || /json/i.test(response.headers.get("content-type") || "")) {
      const payload = await abortable(() => response.json().catch(() => ({})), signal);
      const message = String(payload.message || payload.msg || `模型请求 HTTP ${response.status}`);
      const error = response.status === 429 || isRateLimitMessage(`${message} ${payload.code || ""}`)
        ? platformRequestError("PLATFORM_RATE_LIMIT", RATE_LIMIT_MESSAGE, { status: 429, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) })
        : Object.assign(new Error(message), { status: response.status });
      error.retryable = false;
      // A gateway failure may follow acceptance; it is not proof of rejection.
      error.requestRejected = [400, 401, 402, 403, 404, 405, 422, 429].includes(response.status);
      const businessRejected = response.ok && payload.code != null && !["", "0", "100000"].includes(String(payload.code));
      if (businessRejected) { error.requestRejected = true; error.retryable = error.code !== 'PLATFORM_RATE_LIMIT'; }
      throw error;
    }
    const result = await consumeModelEventStream(response.body, { signal, allowEmpty,
      confirmStopped: () => stopAfterTask && stopPromise ? stopPromise : false,
      onEvent: detail => {
        const previousTask = taskId;
        taskId ||= detail.taskId;
        receivedConversationId ||= detail.conversationId;
        receivedMessageId ||= detail.messageId;
        emit({ ...detail, event: "stream-event", streamEvent: detail.event });
        if (!previousTask && taskId) emit({ event: "task-received", taskId, conversationId: detail.conversationId, messageId: detail.messageId });
        if (stopAfterTask && taskId && !stopPromise && !["message_end", "workflow_finished"].includes(detail.event)) {
          emit({ event: "stop-requested", taskId, reason: "stop-after-task" });
          void stop();
        }
      } });
    assertActive(signal);
    completed = true;
    if (!result.conversationId || !result.messageId) throw Object.assign(new Error("完整回复缺少会话或消息编号，已停止自动重复请求"), { retryable: false });
    if (conversationId && result.conversationId !== conversationId) throw Object.assign(new Error("平台返回了其他会话编号，已停止本轮写入"), { retryable: false });
    if (stopPromise) await abortable(() => stopPromise, signal);
    emit({ event: "stream-completed", taskId, conversationId: result.conversationId, messageId: result.messageId, finishEvent: result.finishEvent, stopAcknowledged });
    return { ...result, stopped: stopAcknowledged, stopAcknowledged };
  } catch (error) {
    const failure = signal?.aborted ? abortError() : error;
    if (failure.retryable == null) failure.retryable = false;
    Object.assign(failure, { taskId, conversationId: receivedConversationId, messageId: receivedMessageId });
    if (!completed && taskId && !stopPromise) void stop();
    emit({ event: signal?.aborted ? "cancelled" : "request-failed", taskId, error: failure.message });
    throw failure;
  } finally { signal?.removeEventListener("abort", cancel); }
}

function requestFreshModel(options = {}) {
  return requestPlatformModel({ ...options, conversationId: undefined, messageId: undefined, createdAt: undefined, isRefresh: false, isUseRefreshCard: undefined });
}
module.exports = { requestFreshModel, requestPlatformModel };
