"use strict";

// Runs inside the platform page. Completion belongs to this request, not to a
// DOM node count or a delayed billing label. There is deliberately no deadline.
function installHostOutputCapture(config) {
  window.__fympHostCapture?.dispose?.();
  const nativeFetch = window.fetch;
  const state = { attemptId: config.attemptId, requestSeen: false, accepted: false,
    conversationId: config.conversationId || null, messageId: null, taskId: null, output: "", events: [] };
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The caller obtains the promise in a second executeJavaScript call.
  promise.catch(() => {});
  const mark = (event, detail = {}) => state.events.push({ event, ...detail });
  const fail = (code, message, retryable = false) => {
    if (settled) return;
    settled = true;
    state.error = { code, message, retryable };
    mark("failed", state.error);
    reject(Object.assign(new Error(message), { code, retryable }));
  };
  const finish = event => {
    if (settled) return;
    if (!state.output.trim()) return fail("GENERATION_EMPTY", "平台已结束生成，但没有回复正文", true);
    if (!state.messageId || !state.conversationId) return fail("REPLY_ID_MISSING", "已收到正文，但平台缺少消息或会话标识；已停止自动重发");
    settled = true;
    state.finishEvent = event;
    mark("completed", { characters: state.output.length });
    resolve({ output: state.output.trim(), conversationId: state.conversationId,
      messageId: state.messageId, taskId: state.taskId, usage: state.usage || null,
      finishEvent: event, attemptId: state.attemptId });
  };
  const inspect = data => {
    state.conversationId ||= data.conversation_id || data.conversationId || null;
    state.messageId ||= data.message_id || data.messageId || data.id || null;
    state.taskId ||= data.task_id || data.taskId || null;
    const event = String(data.event || data.type || "");
    if (event === "error") return fail("GENERATION_FAILED", String(data.message || data.error || "平台生成失败"), true);
    const text = data.answer ?? data.text ?? data.data?.outputs?.answer;
    if (typeof text === "string") {
      if (!state.output && text) mark("first-content");
      state.output = /^(message_replace|text_replace)$/.test(event) ? text : state.output + text;
    }
    state.usage = data.metadata?.usage || data.usage || state.usage;
    if (["message_end", "workflow_finished"].includes(event)) finish(event);
  };
  window.fetch = function(resource, options = {}) {
    let url, body;
    try { url = new URL(typeof resource === "string" ? resource : resource.url, location.href); body = JSON.parse(options.body); } catch {}
    const matched = !settled && url?.origin === location.origin && typeof body?.query === "string"
      && ((url.pathname === "/go/api/apps/chat-messages" && body.app_id === config.appId)
        || url.pathname === `/console/api/installed-apps/${config.appId}/chat-messages`)
      && (!config.conversationId || body.conversation_id === config.conversationId);
    if (!matched) return nativeFetch.call(this, resource, options);
    if (state.requestSeen) return Promise.reject(new Error("本轮请求已发送，请等待结果或停止本轮"));
    state.requestSeen = true;
    state.inputTransformed = body.query !== config.input;
    mark("request-dispatched");
    const request = nativeFetch.call(this, resource, options).then(async response => {
      if ([404,405].includes(response.status) && url.pathname === "/go/api/apps/chat-messages") {
        mark("endpoint-fallback", { status: response.status });
        return nativeFetch.call(window, `/console/api/installed-apps/${encodeURIComponent(config.appId)}/chat-messages`, options);
      }
      return response;
    });
    void request.then(async response => {
      state.accepted = response.ok;
      mark("response-accepted", { status: response.status, contentType: response.headers.get("content-type") });
      if (!response.ok) {
        const failure = await response.clone().json().catch(() => ({}));
        return fail("GENERATION_HTTP_ERROR", String(failure.message || failure.msg || `模型请求 HTTP ${response.status}`), ![401,402,403,404,405].includes(response.status));
      }
      const copy = response.clone();
      if (/json/i.test(copy.headers.get("content-type") || "")) {
        const data = await copy.json();
        if (data.event === "error" || (data.code != null && ![0,100000].includes(data.code))) return fail("GENERATION_FAILED", String(data.message || data.msg || "平台拒绝生成请求"), true);
        inspect(data);
        return finish("json-completed");
      }
      const reader = copy.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!settled) {
          const part = await reader.read();
          buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
          buffer = buffer.replace(/\r\n/g, "\n");
          const blocks = buffer.split("\n\n"); buffer = blocks.pop() || "";
          if (part.done && buffer.trim()) blocks.push(buffer);
          for (const block of blocks) {
            const text = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
            if (!text || /^(ping|keepalive|\[ping\])$/i.test(text)) continue;
            if (text === "[DONE]") { finish("done"); break; }
            try { inspect(JSON.parse(text)); } catch { fail("STREAM_PROTOCOL_ERROR", "模型流事件格式不匹配；已保留本轮标识并停止自动重发"); }
            if (settled) break;
          }
          if (part.done) { if (!settled) fail("STREAM_INTERRUPTED", "模型连接结束但没有完成事件；请恢复或停止本轮，未自动重复生成"); break; }
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }).catch(error => fail("REQUEST_UNCERTAIN", String(error?.message || error)));
    return request;
  };
  const unload = () => fail("PAGE_REPLACED", "回合页面已离开，本次结果不再应用");
  addEventListener("beforeunload", unload, { once: true });
  state.promise = promise;
  state.fail = fail;
  state.dispose = () => { window.fetch = nativeFetch; removeEventListener("beforeunload", unload); };
  window.__fympHostCapture = state;
  return { installed: true, attemptId: config.attemptId };
}

module.exports = { installHostOutputCapture };
