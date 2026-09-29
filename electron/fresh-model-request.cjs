"use strict";
const { abortable, abortError, assertActive } = require("./auto-model-router.cjs");
const { consumeModelEventStream, createModelRequestPayload } = require("./model-stream.cjs");
const { platformRequestError, isRateLimitMessage, retryAfterMs, RATE_LIMIT_MESSAGE } = require("./platform-transport.cjs");

async function requestFreshModel({ fetch, origin, workId, query, files = [], headers, signal, onEvent = () => {} }) {
  assertActive(signal);
  const controller = new AbortController();
  let useGo = true, taskId = null, completed = false;
  const emit = detail => { try { onEvent(detail); } catch {} };
  const installed = `/console/api/installed-apps/${encodeURIComponent(workId)}/chat-messages`;
  const request = { method: "POST", credentials: "include", cache: "no-store", headers,
    signal: controller.signal, body: JSON.stringify(createModelRequestPayload({ workId, query, files })) };
  const stop = async () => {
    let go = useGo;
    for (;;) {
      const path = go ? "/go/api/apps/chat-stop" : `${installed}/${encodeURIComponent(taskId)}/stop`;
      const response = await fetch(new URL(path, origin).href, { method: "POST", credentials: "include", headers,
        ...(go ? { body: JSON.stringify({ task_id: taskId }) } : {}) });
      if (go && [404, 405].includes(response.status)) { go = false; continue; }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload.code != null && !["", 0, 100000].includes(payload.code))) throw new Error(payload.message || payload.msg || `HTTP ${response.status}`);
      emit({ event: "stop-acknowledged", taskId });
      return;
    }
  };
  const cancel = () => {
    controller.abort();
    if (!completed && taskId) {
      emit({ event: "stop-requested", taskId });
      void stop().catch(error => emit({ event: "stop-unconfirmed", taskId, error: error.message }));
    } else if (!completed) emit({ event: "stop-unconfirmed", taskId: null, reason: "task-id-not-yet-received" });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    emit({ event: "request-dispatched", newConversation: true });
    let response = await abortable(() => fetch(new URL("/go/api/apps/chat-messages", origin).href, request), signal);
    if ([404, 405].includes(response.status)) {
      useGo = false;
      emit({ event: "endpoint-fallback", status: response.status });
      response = await abortable(() => fetch(new URL(installed, origin).href, request), signal);
    }
    emit({ event: "response-received", status: response.status });
    if (!response.ok || /json/i.test(response.headers.get("content-type") || "")) {
      const payload = await abortable(() => response.json().catch(() => ({})), signal);
      const message = String(payload.message || payload.msg || `模型请求 HTTP ${response.status}`);
      const error = response.status === 429 || isRateLimitMessage(`${message} ${payload.code || ""}`)
        ? platformRequestError("PLATFORM_RATE_LIMIT", RATE_LIMIT_MESSAGE, { status: 429, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) })
        : new Error(message);
      error.retryable = ![401, 402, 403, 404, 405].includes(response.status);
      throw error;
    }
    const result = await consumeModelEventStream(response.body, { signal, onEvent: detail => {
      const previousTask = taskId;
      taskId ||= detail.taskId;
      if (!previousTask && taskId) emit({ event: "task-received", taskId, conversationId: detail.conversationId });
    } });
    assertActive(signal);
    completed = true;
    if (!result.conversationId || !result.messageId) throw Object.assign(new Error("完整回复缺少会话或消息编号，已停止自动重复请求"), { retryable: false });
    emit({ event: "stream-completed", taskId, conversationId: result.conversationId, messageId: result.messageId, finishEvent: result.finishEvent });
    return result;
  } catch (error) {
    const failure = signal?.aborted ? abortError() : error;
    // A broken connection is not proof that the server rejected the request.
    if (failure.retryable == null) failure.retryable = false;
    emit({ event: signal?.aborted ? "cancelled" : "request-failed", taskId, error: failure.message });
    throw failure;
  } finally { signal?.removeEventListener("abort", cancel); }
}
module.exports = { requestFreshModel };
