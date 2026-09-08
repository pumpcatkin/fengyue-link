// Executed in the platform document. Keep this function self-contained so live
// Electron and deterministic stream tests exercise exactly the same observer.
function installGuestOutputGuard(config) {
  let registry = window.__fympGuestOutputGuard;
  if (!registry) {
    registry = window.__fympGuestOutputGuard = { states: Object.create(null), active: null };
    const nativeFetch = window.fetch;
    registry.fetch = nativeFetch;
    window.fetch = function(resource, options = {}) {
      const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
      let body;
      try { body = JSON.parse(options.body); } catch {}
      const state = registry.active;
      const go = url.pathname === '/go/api/apps/chat-messages';
      const py = state && url.pathname === `/console/api/installed-apps/${state.appId}/chat-messages`;
      const matched = state && !state.finishedAt && url.origin === location.origin && (go || py)
        && (!go || body?.app_id === state.appId) && typeof body?.query === 'string'
        && (!state.conversationId || body?.conversation_id === state.conversationId);
      if (!matched) return nativeFetch.call(this, resource, options);
      if (state.requestSeen) return Promise.reject(new Error('本轮访客请求已经发送，已阻止重复生成'));
      state.requestSeen = true;
      // Work input filters may transform the query. Still stop this armed
      // app/conversation request; record verification checks the input later.
      state.inputTransformed = body.query !== state.input;
      if (state.hadResponseMode) window.actualResponseMode = state.previousResponseMode;
      else delete window.actualResponseMode;
      state.startedAt = Date.now();
      const request = nativeFetch.call(this, resource, options);
      void request.then(async response => {
        const headers = new Headers(options.headers || {});
        headers.set('Content-Type', 'application/json');
        if (!headers.has('Authorization')) {
          const token = localStorage.getItem('console_token');
          if (token) headers.set('Authorization', 'Bearer ' + token);
        }
        const stop = async () => {
          const stopUrl = go ? '/go/api/apps/chat-stop'
            : `/console/api/installed-apps/${state.appId}/chat-messages/${encodeURIComponent(state.taskId)}/stop`;
          for (let attempt = 1; attempt <= 4; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            try {
              const result = await nativeFetch.call(window, stopUrl, {
                method: 'POST', credentials: 'include', headers, signal: controller.signal,
                ...(go ? { body: JSON.stringify({ task_id: state.taskId }) } : {})
              });
              const payload = await result.json().catch(() => ({}));
              const code = payload.code;
              if (!result.ok || (code != null && code !== '' && code !== 0 && code !== 100000)) throw new Error(payload.msg || payload.message || `HTTP ${result.status}`);
              state.stopAcknowledged = true;
              state.stopAt = Date.now();
              state.stopAttempts = attempt;
              return;
            } catch (error) {
              state.stopError = error.message;
              state.stopAttempts = attempt;
              if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 150));
            } finally { clearTimeout(timer); }
          }
        };
        let stopPromise = null;
        const inspect = data => {
          if (!data || typeof data !== 'object') return;
          if (data.conversation_id) state.conversationId = data.conversation_id;
          if (data.message_id || data.id) state.messageId = data.message_id || data.id;
          if (data.model_id) state.model = data.model_id;
          if (data.metadata?.usage) state.usage = data.metadata.usage;
          if (typeof data.answer === 'string') state.outputCharacters += data.answer.length;
          if (data.task_id && !state.taskId) {
            state.taskId = String(data.task_id);
            state.taskAt = Date.now();
            stopPromise = stop();
          }
          if (data.event === 'message_end' || data.event === 'workflow_finished') state.terminalEvent = true;
          if (data.event === 'error' || Number(data.status) >= 400) state.error = data.message || data.msg || '平台生成失败';
          if (typeof data.code === 'number' && data.code !== 0 && data.code !== 100000) state.error = data.message || data.msg || '平台拒绝了生成请求';
        };
        try {
          if (!response.ok) throw new Error(`访客生成请求失败：HTTP ${response.status}`);
          const copy = response.clone();
          if ((copy.headers.get('content-type') || '').includes('application/json')) {
            const payload = await copy.json();
            inspect(payload);
            if (payload?.data) inspect(payload.data);
            state.terminalEvent = !state.error;
          } else {
            const reader = copy.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            const line = text => {
              if (!text.startsWith('data:')) return;
              const value = text.slice(5).trim();
              if (value === '[DONE]') { state.terminalEvent = true; return; }
              try { inspect(JSON.parse(value)); } catch {}
            };
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              state.lastChunkAt = Date.now();
              pending += decoder.decode(part.value, { stream: true });
              let end;
              while ((end = pending.indexOf('\n')) >= 0) {
                line(pending.slice(0, end).trim());
                pending = pending.slice(end + 1);
              }
              if (pending.length > 1048576) throw new Error('平台响应流没有合法的事件边界');
            }
            if (pending.trim()) line(pending.trim());
          }
          state.streamEnded = true;
        } catch (error) {
          state.streamError = error.message;
          // An aborted local connection is not proof that the server stopped.
        }
        if (stopPromise) await stopPromise;
        state.ready = Boolean(state.streamEnded && !state.error && (state.stopAcknowledged || state.terminalEvent));
        if (!state.ready) state.error ||= state.stopError || state.streamError || '平台没有确认访客生成结束';
        state.finishedAt = Date.now();
        if (registry.active === state) registry.active = null;
      }).catch(error => {
        state.error = error.message;
        state.finishedAt = Date.now();
        if (registry.active === state) registry.active = null;
      });
      return request;
    };
  }
  let state = registry.states[config.syncKey];
  if (!state) {
    if (registry.active?.requestSeen && !registry.active.finishedAt) throw new Error('上一轮访客请求尚未确认结束，已阻止新生成');
    state = registry.states[config.syncKey] = { ...config, requestSeen: false, ready: false, outputCharacters: 0, stopAcknowledged: false,
      hadResponseMode: Object.prototype.hasOwnProperty.call(window, 'actualResponseMode'), previousResponseMode: window.actualResponseMode };
  }
  if (!state.finishedAt) registry.active = state;
  // The platform reads this setting when its send button constructs the request.
  // Blocking responses have no early task id and cannot be stopped promptly.
  if (!state.requestSeen) window.actualResponseMode = 'streaming';
  return { requestSeen: state.requestSeen, ready: state.ready, error: state.error || null };
}

module.exports = { installGuestOutputGuard };
