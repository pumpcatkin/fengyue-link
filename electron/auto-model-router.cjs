"use strict";

function unwrap(value) { return value?.data?.data ?? value?.data ?? value?.result ?? value ?? {}; }
function metric(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(String(value).replace(/%$/, ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function priority(model) {
  const text = `${model.model} ${model.label}`.toLowerCase();
  if (!/flash/.test(text)) return 2;
  if (/deepseek[\s_-]*v?4(?:\D|$)/.test(text) || /glm[\s_-]*5[._-]3(?:\D|$)/.test(text)) return 0;
  const version = text.match(/gemini[\s_-]*(\d+)(?:[._-](\d+))?/);
  if (version && (Number(version[1]) > 3 || Number(version[1]) === 3 && Number(version[2] || 0) >= 5)) return 1;
  return 2;
}
function normalizeCatalog(payload) {
  const data = unwrap(payload);
  const records = Array.isArray(data) ? data : data.models || data.items || [];
  const unique = new Map();
  for (const record of records) {
    const provider = String(record.provider_name ?? record.provider ?? "").trim();
    const model = String(record.model_id ?? record.model ?? record.name ?? "").trim();
    if (!provider || !model || record.enabled === false || record.is_enabled === false
      || /^(disabled|offline|unavailable|deleted)$/i.test(record.status || "")
      || record.modalities?.output?.text?.supported === false || record.support_streaming === false) continue;
    const rawLabel = record.model_label ?? record.label ?? model;
    const label = typeof rawLabel === "object" ? String(rawLabel.zh_Hans ?? rawLabel.zh_CN ?? rawLabel.en_US ?? model) : String(rawLabel);
    const key = `${provider}\0${model}`;
    if (unique.has(key)) continue;
    const success = metric(record.success_rate ?? record.successRate);
    const item = {
      key, provider, model, label,
      price: metric(record.model_price ?? record.priceCoefficient),
      // Platform success_rate is percent, including values below one percent.
      successRate: success == null ? null : Math.min(100, success),
      latency: metric(record.average_latency ?? record.averageLatency),
      parameterRanges: record.parameter_ranges || {}
    };
    item.priority = priority(item);
    unique.set(key, item);
  }
  return [...unique.values()];
}
function rankModels(items) {
  const score = item => item.price == null || item.successRate == null ? -1
    : item.price === 0 ? (item.successRate > 0 ? Infinity : 0) : item.successRate / item.price;
  return [...items].sort((a, b) => a.priority - b.priority
    || (score(a) === score(b) ? 0 : score(a) > score(b) ? -1 : 1)
    || (a.latency > 0 ? a.latency : Infinity) - (b.latency > 0 ? b.latency : Infinity)
    || (a.price ?? Infinity) - (b.price ?? Infinity) || a.key.localeCompare(b.key));
}
function abortError() { const error = new Error("已取消模型请求"); error.name = "AbortError"; return error; }
function assertActive(signal) { if (signal?.aborted) throw abortError(); }
function retryable(error) {
  if (error?.name === "AbortError" || error?.retryable === false) return false;
  return !/积分不足|余额不足|insufficient.*(?:credit|balance|point)|未登录|登录已过期|请先.*登录|unauthenticated|unauthorized|没有权限/i.test(error?.message || "");
}
function delay(ms, signal) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function retryDelay(baseMs, error) {
  const hinted = Math.max(0, Number(error?.retryAfterMs || 0));
  return Math.min(10 * 60 * 1000, Math.max(baseMs, hinted));
}

// A round visits every live candidate once. Refreshing between rounds admits new
// models and avoids retrying a cached, removed model forever. No attempt ceiling.
async function runAutoModel({ loadModels, execute, signal, onState = () => {}, wait = delay, maxAttempts = null }) {
  let attempt = 0;
  let cycle = 0;
  for (;;) {
    assertActive(signal);
    cycle += 1;
    onState({ stage: "selecting", attempt, cycle });
    let candidates;
    try {
      candidates = rankModels(await loadModels());
      assertActive(signal);
      if (!candidates.length) throw new Error("平台暂未返回可用文本模型");
    } catch (error) {
      if (!retryable(error)) throw error;
      if (maxAttempts != null && Number.isFinite(Number(maxAttempts)) && cycle >= Math.max(1, Number(maxAttempts))) throw error;
      assertActive(signal);
      const retryAfterMs = retryDelay(Math.min(30000, 1500 * 2 ** Math.min(cycle - 1, 5)), error);
      onState({ stage: "waiting", attempt, cycle, retryAfterMs, error: error.message });
      await wait(retryAfterMs, signal);
      continue;
    }
    for (const model of candidates) {
      assertActive(signal);
      attempt += 1;
      onState({ stage: "generating", attempt, cycle, model: model.label, provider: model.provider });
      try {
        const result = await execute({ model, attempt, signal });
        assertActive(signal);
        return result;
      } catch (error) {
        if (maxAttempts != null && Number.isFinite(Number(maxAttempts)) && attempt >= Math.max(1, Number(maxAttempts))) throw error;
        if (!retryable(error)) throw error;
        assertActive(signal);
        const retryAfterMs = retryDelay(Math.min(30000, 1000 * 2 ** Math.min(cycle - 1, 5)), error);
        onState({ stage: "waiting", attempt, cycle, model: model.label, provider: model.provider, retryAfterMs, error: error.message });
        await wait(retryAfterMs, signal);
      }
    }
  }
}

module.exports = { normalizeCatalog, rankModels, priority, runAutoModel, abortError, assertActive, retryable, retryDelay };
