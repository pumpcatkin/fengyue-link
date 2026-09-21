"use strict";

function platformRequestError(code, message, detail = {}) {
  return Object.assign(new Error(`[${code}] ${message}`), { code, ...detail });
}

function isTransientPlatformError(error) {
  if ([401, 403, 429].includes(Number(error?.status))) return false;
  if (String(error?.code || "").startsWith("PLATFORM_")) return ["PLATFORM_NETWORK", "PLATFORM_TIMEOUT", "PLATFORM_SERVER"].includes(error.code);
  const message = `${error?.code || ""} ${error?.message || error || ""}`;
  if (/\b(?:401|403|429)\b|unauthorized|forbidden|rate limit|频繁|限流/i.test(message)) return false;
  return /fetch|network|connection|timeout|timed out|temporary|ECONN|ETIMEDOUT|ERR_(?:NETWORK|CONNECTION|HTTP2|QUIC)|\b(?:408|500|502|503|504)\b|网络|超时|连接/i.test(message);
}

function platformMessage(payload, fallback) {
  const value = payload?.message ?? payload?.msg ?? payload?.error;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : fallback;
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 30000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, delay) : 30000;
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
          void response.body?.cancel().catch(() => {});
          const status = response.status;
          const code = status === 401 || status === 403 ? "PLATFORM_AUTH"
            : status === 429 ? "PLATFORM_RATE_LIMIT"
              : status >= 500 || status === 408 ? "PLATFORM_SERVER"
                : status >= 300 && status < 400 ? "PLATFORM_REDIRECT" : "PLATFORM_HTTP";
          throw platformRequestError(code, `平台响应 HTTP ${status}`, {
            status, ...(status === 429 ? { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) } : {})
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
          throw platformRequestError("PLATFORM_API", platformMessage(payload, "平台未接受请求"), { apiCode: String(payload.code), status: response.status });
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

module.exports = { requestPlatformJson, platformRequestError, isTransientPlatformError };
