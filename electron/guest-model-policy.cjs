// Missing/invalid platform metrics must never become zero.
function modelMetric(value, { percent = false } = {}) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  let text = String(value).trim();
  if (!text) return null;
  text = percent ? text.replace(/%$/, "").trim() : text.replace(/^[×x]\s*|\s*[×x]$/gi, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && (!percent || number <= 100) ? number : null;
}

const PREFERRED_GUEST_MODEL_FAMILY = "grok";
const TESTED_GUEST_MODELS = [
  { provider: "sticky_grok", model: "grok-4.5" },
  { provider: "dian_glm", model: "glm-5.3-flash" },
  { provider: "yuegle_google_vertex", model: "gemini-2.5-flash" },
  { provider: "hiagi_deepseek", model: "deepseek-v4-flash" },
  { provider: "manei_anthropic_official_v2", model: "claude-sonnet-4-6" },
  { provider: "dian_openai_codex", model: "gpt-5.4" }
];

function selectGuestModel(items = []) {
  const preferred = items.find(item => item.provider === TESTED_GUEST_MODELS[0].provider && item.model === TESTED_GUEST_MODELS[0].model);
  if (preferred) return preferred;
  const candidates = items
    .filter(item => item.family === PREFERRED_GUEST_MODEL_FAMILY && item.provider && item.model)
    .map(item => ({ item, price: modelMetric(item.priceCoefficient), rate: modelMetric(item.successRate, { percent: true }) }))
    .filter(candidate => candidate.price !== null)
    .sort((a, b) => a.price - b.price
      || (a.rate ?? Infinity) - (b.rate ?? Infinity)
      || `${a.item.provider}\0${a.item.model}`.localeCompare(`${b.item.provider}\0${b.item.model}`, "en"));
  if (!candidates.length) {
    for (const tested of TESTED_GUEST_MODELS.slice(1)) {
      const fallback = items.find(item => item.provider === tested.provider && item.model === tested.model);
      if (fallback) return fallback;
    }
    throw new Error("当前列表没有可用的 Grok 或其他实测型号，暂不发送访客占位请求");
  }
  return candidates[0].item;
}

function matchesConfiguredModel(config, target) {
  return config?.model?.provider === target.provider
    && (config?.model?.name || config?.model?.model) === target.model;
}

module.exports = { modelMetric, selectGuestModel, matchesConfiguredModel, PREFERRED_GUEST_MODEL_FAMILY, TESTED_GUEST_MODELS };
