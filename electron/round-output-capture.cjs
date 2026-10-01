"use strict";

// Runs inside the platform page. Completion belongs to this request, not to a
// DOM node count or a delayed billing label. There is deliberately no deadline.
function installHostOutputCapture(config = null) {
  // Install this dispatcher at document start. A platform SDK may cache fetch
  // before a round begins; that cached function must see the active capture.
  let bridge = window.__fympHostFetchBridge;
  if (!bridge) {
    const nativeFetch = window.fetch;
    bridge = { nativeFetch, handle: null };
    window.fetch = function(...args) {
      return bridge.handle ? bridge.handle(this, args) : nativeFetch.apply(this, args);
    };
    window.__fympHostFetchBridge = bridge;
  }
  if (!config) return { installed: true };
  window.__fympHostCapture?.dispose?.();
  const nativeFetch = bridge.nativeFetch;
  const state = { attemptId: config.attemptId, requestSeen: false, accepted: false,
    conversationId: config.conversationId || null, messageId: null, taskId: null, output: "", events: [] };
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The caller obtains the promise in a second executeJavaScript call.
  promise.catch(() => {});
  const mark = (event, detail = {}) => {
    const entry = { event, ...detail };
    state.events.push(entry);
    try { console.debug("FYMP_HOST_CAPTURE " + JSON.stringify({ attemptId: config.attemptId, ...entry })); } catch {}
  };
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
  const handle = async (receiver, args) => {
    const [resource, options = {}] = args;
    let url, body, bodyText;
    try { url = new URL(resource?.url || resource, location.href); } catch {}
    const endpoint = url?.origin === location.origin
      && (url.pathname === "/go/api/apps/chat-messages" || url.pathname === `/console/api/installed-apps/${config.appId}/chat-messages`);
    if (settled || !endpoint) return nativeFetch.apply(receiver, args);
    try {
      bodyText = options.body ?? (typeof resource?.clone === "function" ? await resource.clone().text() : undefined);
      body = JSON.parse(bodyText);
    } catch {}
    // Another request may have completed while reading a Request object's body.
    const matched = !settled && typeof body?.query === "string"
      && ((url.pathname === "/go/api/apps/chat-messages" && body.app_id === config.appId)
        || url.pathname === `/console/api/installed-apps/${config.appId}/chat-messages`)
      && (!config.conversationId || body.conversation_id === config.conversationId);
    if (!matched) return nativeFetch.apply(receiver, args);
    if (state.requestSeen) return Promise.reject(new Error("本轮请求已发送，请等待结果或停止本轮"));
    state.requestSeen = true;
    state.inputTransformed = body.query !== config.input;
    mark("request-dispatched");
    const fallbackOptions = typeof resource?.clone === "function" ? {
      method: resource.method, headers: resource.headers, credentials: resource.credentials,
      signal: resource.signal, ...options, body: bodyText
    } : options;
    const request = Promise.resolve().then(() => nativeFetch.apply(receiver, args)).then(async response => {
      if ([404,405].includes(response.status) && url.pathname === "/go/api/apps/chat-messages") {
        mark("endpoint-fallback", { status: response.status });
        return nativeFetch.call(window, `/console/api/installed-apps/${encodeURIComponent(config.appId)}/chat-messages`, fallbackOptions);
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
  bridge.handle = handle;
  const unload = () => fail("PAGE_REPLACED", "回合页面已离开，本次结果不再应用");
  addEventListener("beforeunload", unload, { once: true });
  state.promise = promise;
  state.fail = fail;
  state.mark = mark;
  state.dispose = () => {
    fail("CAPTURE_REPLACED", "回合捕获已结束或被新的请求替换");
    if (bridge.handle === handle) bridge.handle = null;
    removeEventListener("beforeunload", unload);
  };
  window.__fympHostCapture = state;
  return { installed: true, attemptId: config.attemptId };
}

// Runs in a hidden WebContentsView as well as a visible page. Readiness and
// dispatch have bounded waits; an accepted model stream has no time limit.
async function sendHostModelInput(modelInput, { readyTimeoutMs = 15000, dispatchTimeoutMs = 10000 } = {}) {
  const capture = window.__fympHostCapture;
  if (!capture) throw new Error("回合回复捕获尚未就绪");
  const waitUntil = async (predicate, timeoutMs, code, message) => {
    const end = Date.now() + timeoutMs;
    while (!predicate()) {
      if (capture.error) return capture.promise;
      if (Date.now() >= end) { capture.fail(code, message, false); return capture.promise; }
      await Promise.race([capture.promise, new Promise(resolve => setTimeout(resolve, 25))]);
    }
    if (capture.error) return capture.promise;
  };
  const inputReady = () => {
    const input = document.querySelector('#ai-chat-input');
    return input && !input.disabled && !input.readOnly && document.querySelector('#ai-send-button');
  };
  capture.mark('waiting-input');
  await waitUntil(inputReady, readyTimeoutMs, 'PAGE_NOT_READY', '页面输入控件尚未就绪，本轮未发送');
  const input = document.querySelector('#ai-chat-input');
  const previous = input.value;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, modelInput);
  try { input._valueTracker?.setValue(previous); } catch {}
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: modelInput }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Yield for framework updates without depending on painting a hidden view.
  await Promise.race([capture.promise, new Promise(resolve => setTimeout(resolve, 0))]);
  await waitUntil(() => {
    const current = document.querySelector('#ai-chat-input');
    const send = document.querySelector('#ai-send-button');
    return current && !current.disabled && !current.readOnly && current.value === modelInput
      && send && !send.disabled && send.getAttribute('aria-disabled') !== 'true';
  }, readyTimeoutMs, 'SEND_NOT_READY', '输入或发送按钮尚未就绪，本轮未发送');
  capture.mark('input-ready');
  capture.mark('send-clicked');
  document.querySelector('#ai-send-button').click();
  await waitUntil(() => capture.requestSeen, dispatchTimeoutMs, 'REQUEST_NOT_OBSERVED', '发送后未捕获到本轮请求，已停止等待；请检查平台记录后恢复本轮');
  return capture.promise;
}

module.exports = { installHostOutputCapture, sendHostModelInput };
