"use strict";

const RATE_LIMIT_MESSAGE = "请求过于频繁，请稍后";

class PlatformRequestQueue {
  constructor({ readConcurrency = 4, writeConcurrency = 1, maxPending = 256, onEvent = () => {} } = {}) {
    this.lanes = {
      read: { limit: Math.max(1, Math.trunc(readConcurrency)), running: 0, queue: [] },
      write: { limit: Math.max(1, Math.trunc(writeConcurrency)), running: 0, queue: [] }
    };
    this.maxPending = Math.max(8, Math.trunc(maxPending));
    this.sequence = 0;
    this.closed = false;
    this.readInFlight = new Map();
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
  }

  laneFor(method) {
    return String(method || "GET").toUpperCase() === "GET" ? "read" : "write";
  }

  queueError(message = "平台请求队列已满") {
    return platformRequestError("PLATFORM_QUEUE_FULL", message, { retryable: true, retryAfterMs: 1000 });
  }

  enqueue(task, { method = "GET", key = "", signal = null, priority = 0 } = {}) {
    if (typeof task !== "function") return Promise.reject(this.queueError("平台请求任务无效"));
    if (this.closed) return Promise.reject(platformRequestError("PLATFORM_CANCELLED", "平台请求已取消"));
    if (signal?.aborted) return Promise.reject(platformRequestError("PLATFORM_CANCELLED", "平台请求已取消"));
    const laneName = this.laneFor(method);
    const lane = this.lanes[laneName];
    const dedupeKey = laneName === "read" && key ? String(key) : "";
    if (dedupeKey && this.readInFlight.has(dedupeKey)) return this.readInFlight.get(dedupeKey);
    const pendingCount = Object.values(this.lanes).reduce((total, item) => total + item.queue.length + item.running, 0);
    if (pendingCount >= this.maxPending) return Promise.reject(this.queueError());
    const enqueuedAt = Date.now();
    const promise = new Promise((resolve, reject) => {
      lane.queue.push({ task, resolve, reject, signal, priority: Number(priority) || 0, sequence: ++this.sequence, enqueuedAt });
      lane.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      this.onEvent({ event: "request-queued", lane: laneName, depth: lane.queue.length, method: String(method || "GET").toUpperCase() });
      this.pump(laneName);
    });
    if (dedupeKey) {
      this.readInFlight.set(dedupeKey, promise);
      promise.finally(() => {
        if (this.readInFlight.get(dedupeKey) === promise) this.readInFlight.delete(dedupeKey);
      }).catch(() => {});
    }
    return promise;
  }

  pump(laneName) {
    const lane = this.lanes[laneName];
    while (!this.closed && lane.running < lane.limit && lane.queue.length) {
      const job = lane.queue.shift();
      if (job.signal?.aborted) {
        job.reject(platformRequestError("PLATFORM_CANCELLED", "平台请求已取消"));
        continue;
      }
      lane.running += 1;
      const waitMs = Math.max(0, Date.now() - job.enqueuedAt);
      if (waitMs >= 250) this.onEvent({ event: "request-dequeued", lane: laneName, waitMs, method: laneName === "read" ? "GET" : "WRITE" });
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        lane.running -= 1;
        this.pump(laneName);
      });
    }
  }

  close() {
    this.closed = true;
    for (const lane of Object.values(this.lanes)) {
      for (const job of lane.queue.splice(0)) job.reject(platformRequestError("PLATFORM_CANCELLED", "平台请求已取消"));
    }
    this.readInFlight.clear();
  }

  snapshot() {
    return {
      closed: this.closed,
      read: { running: this.lanes.read.running, queued: this.lanes.read.queue.length },
      write: { running: this.lanes.write.running, queued: this.lanes.write.queue.length }
    };
  }
}

function platformRequestError(code, message, detail = {}) {
  return Object.assign(new Error(code === "PLATFORM_RATE_LIMIT" ? message : `[${code}] ${message}`), { code, ...detail });
}

function isTransientPlatformError(error) {
  if ([401, 403, 429].includes(Number(error?.status))) return false;
  if (String(error?.code || "").startsWith("PLATFORM_")) return ["PLATFORM_NETWORK", "PLATFORM_TIMEOUT", "PLATFORM_SERVER"].includes(error.code);
  const message = `${error?.code || ""} ${error?.message || error || ""}`;
  if (/\b(?:401|403|429)\b|unauthorized|forbidden|rate limit|频繁|限流/i.test(message)) return false;
  return /fetch|network|connection|timeout|timed out|temporary|ECONN|ETIMEDOUT|ERR_(?:NETWORK|CONNECTION|HTTP2|QUIC)|\b(?:408|500|502|503|504)\b|网络|超时|连接/i.test(message);
}

function isRateLimitMessage(value) {
  return /(?:(?:评论|请求|操作)\s*)*过于频繁|请求频繁|rate[\s_-]*limit|too[\s_-]*frequent|too many requests|throttl|\b429\d*\b/i.test(String(value || ""));
}

function platformMessage(payload, fallback) {
  const values = [
    payload?.message, payload?.msg,
    typeof payload?.error === "string" ? payload.error : payload?.error?.message,
    payload?.data?.message, payload?.data?.msg
  ];
  const value = values.find(item => typeof item === "string" && item.trim());
  const message = value ? value.trim().slice(0, 240) : fallback;
  return isRateLimitMessage(message) ? RATE_LIMIT_MESSAGE : message;
}

async function readPlatformError(response, signal) {
  let text = "";
  try { text = await response.text(); }
  catch {
    if (signal?.aborted) throw platformRequestError("PLATFORM_TIMEOUT", "平台响应读取超时");
  }
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  const plainText = !payload && text && !/<(?:!doctype|html|body)\b/i.test(text)
    ? text.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  return { payload: payload && typeof payload === "object" ? payload : null, plainText };
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 30000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, delay) : 30000;
}

function platformRateLimitScope(origin, pathname, method = "GET") {
  const verb = String(method || "GET").toUpperCase();
  const route = String(pathname || "").split("?")[0];
  if (verb !== "GET" && /^\/console\/api\/comments(?:\/|$)/.test(route)) return `${origin}:comments:write`;
  return `${origin}:${verb}:${route}`;
}

// Use the account's Chromium session, independently of its renderer lifecycle.
// Only reads are retried here; writes retain their caller's transaction identity.
async function requestPlatformJson({ fetch, origin, pathname, token = "", method = "GET", body, timeout = 12000, attempts = 2, signal, onRetry = () => {} }) {
  const url = new URL(pathname, origin);
  if (url.origin !== new URL(origin).origin || !/^\/(?:console|go)\/api\//.test(url.pathname)) {
    throw platformRequestError("PLATFORM_URL", "平台请求地址无效");
  }
  const verb = String(method).toUpperCase();
  const count = verb === "GET" ? Math.max(1, Math.min(2, Number(attempts) || 1)) : 1;
  for (let attempt = 1; attempt <= count; attempt += 1) {
    if (signal?.aborted) throw platformRequestError("PLATFORM_CANCELLED", "平台请求已取消");
    const controller = new AbortController();
    let timer;
    let cancel;
    try {
      const deadline = new Promise((_, reject) => {
        cancel = () => {
          controller.abort();
          reject(platformRequestError("PLATFORM_CANCELLED", "平台请求已取消"));
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) return cancel();
        timer = setTimeout(() => {
          controller.abort();
          reject(platformRequestError("PLATFORM_TIMEOUT", "平台请求超时"));
        }, Math.max(100, Math.min(30000, Number(timeout) || 12000)));
      });
      const operation = (async () => {
        const headers = { Accept: "application/json", "Content-Type": "application/json", "X-Language": "zh-Hans", Origin: url.origin, Referer: `${url.origin}/zh/chats` };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(url.href, {
          method: verb, headers, credentials: "include", cache: "no-store",
          redirect: "manual", signal: controller.signal,
          ...(body == null ? {} : { body: JSON.stringify(body) })
        });
        if (!response.ok) {
          const httpStatus = response.status;
          const { payload, plainText } = await readPlatformError(response, controller.signal);
          const apiCode = payload?.code ?? payload?.error_code ?? payload?.errorCode;
          const fallback = plainText || `平台响应 HTTP ${httpStatus}`;
          const message = platformMessage(payload, fallback);
          // The platform currently reports comment throttling through both 429
          // and HTTP 400 business responses. Normalize both without retrying a
          // write here; the durable game outbox owns that retry.
          const rateLimited = httpStatus === 429 || isRateLimitMessage(`${message} ${apiCode ?? ""}`);
          const status = rateLimited ? 429 : httpStatus;
          const code = rateLimited ? "PLATFORM_RATE_LIMIT"
            : httpStatus === 401 || httpStatus === 403 ? "PLATFORM_AUTH"
              : httpStatus >= 500 || httpStatus === 408 ? "PLATFORM_SERVER"
                : httpStatus >= 300 && httpStatus < 400 ? "PLATFORM_REDIRECT" : "PLATFORM_HTTP";
          throw platformRequestError(code, rateLimited ? RATE_LIMIT_MESSAGE : message, {
            status, httpStatus,
            ...(apiCode == null ? {} : { apiCode: String(apiCode) }),
            ...(rateLimited ? { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) } : {})
          });
        }
        if (response.status === 204 || response.status === 205) {
          return { payload: {}, serverTime: Date.parse(response.headers.get("date") || "") };
        }
        let payload;
        try { payload = await response.json(); }
        catch {
          if (controller.signal.aborted) throw platformRequestError("PLATFORM_TIMEOUT", "平台响应读取超时");
          throw platformRequestError("PLATFORM_INVALID_JSON", "平台返回了非数据响应");
        }
        if (payload == null || typeof payload !== "object") throw platformRequestError("PLATFORM_INVALID_JSON", "平台返回的数据格式无效");
        if (payload.code != null && ![0, 100000].includes(Number(payload.code))) {
          const message = platformMessage(payload, "平台未接受请求");
          const rateLimited = message === RATE_LIMIT_MESSAGE || isRateLimitMessage(payload.code);
          throw platformRequestError(rateLimited ? "PLATFORM_RATE_LIMIT" : "PLATFORM_API", rateLimited ? RATE_LIMIT_MESSAGE : message, {
            apiCode: String(payload.code), status: rateLimited ? 429 : response.status,
            ...(rateLimited ? { retryAfterMs: 30000 } : {})
          });
        }
        return { payload, serverTime: Date.parse(response.headers.get("date") || "") };
      })();
      return await Promise.race([operation, deadline]);
    } catch (error) {
      const failure = signal?.aborted ? platformRequestError("PLATFORM_CANCELLED", "平台请求已取消")
        : String(error?.code || "").startsWith("PLATFORM_") ? error
          : platformRequestError("PLATFORM_NETWORK", platformMessage({ message: error?.message }, "平台连接中断"));
      if (attempt === count || !isTransientPlatformError(failure)) throw failure;
      onRetry({ attempt, code: failure.code, status: failure.status || null });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    if (signal?.aborted) throw platformRequestError("PLATFORM_CANCELLED", "平台请求已取消");
  }
}

module.exports = {
  requestPlatformJson, platformRequestError, isTransientPlatformError,
  platformMessage, isRateLimitMessage, platformRateLimitScope, RATE_LIMIT_MESSAGE,
  PlatformRequestQueue
};
