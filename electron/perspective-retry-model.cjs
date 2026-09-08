function unwrapModelPayload(payload) {
  return payload?.data?.data ?? payload?.data ?? payload?.result ?? payload ?? {};
}

function modelKey(value) {
  const provider = String(value?.provider ?? value?.provider_name ?? "").trim();
  const model = String(value?.model ?? value?.model_id ?? value?.name ?? "").trim();
  return provider && model ? `${provider}\0${model}` : "";
}

function modelLabel(record, model) {
  const value = record?.model_label ?? record?.label ?? model;
  if (!value || typeof value !== "object") return String(value || model);
  return String(value.zh_Hans ?? value.zh_CN ?? value.en_US ?? Object.values(value)[0] ?? model);
}

function buildPerspectiveRetryModelPlan(listPayload, configPayload) {
  const list = unwrapModelPayload(listPayload);
  const config = unwrapModelPayload(configPayload);
  const records = Array.isArray(list?.models) ? list.models : Array.isArray(list) ? list : [];
  const originalModel = config?.model && typeof config.model === "object" ? { ...config.model } : null;
  const originalKey = modelKey({ provider: originalModel?.provider, model: originalModel?.name || originalModel?.model });
  const unique = new Map();
  for (const record of records) {
    const provider = String(record?.provider_name ?? record?.provider ?? "").trim();
    const model = String(record?.model_id ?? record?.model ?? record?.name ?? "").trim();
    const key = modelKey({ provider, model });
    if (!key || key === originalKey || unique.has(key)) continue;
    const label = modelLabel(record, model);
    const text = `${provider} ${model} ${label}`.toLowerCase();
    const compact = text.replace(/[^a-z0-9]/g, "");
    const flash = /flash/.test(text);
    const geminiFlash = flash && /gemini/.test(text);
    const deepseekV4Flash = flash && compact.includes("deepseek") && compact.includes("deepseekv4");
    unique.set(key, { provider, model, label, key, geminiFlash, deepseekV4Flash });
  }
  const candidates = [...unique.values()];
  const take = predicate => {
    const index = candidates.findIndex(predicate);
    return index < 0 ? null : candidates.splice(index, 1)[0];
  };
  // There are only two retries. Reserve their first slots for the two model
  // families requested by the user, then retain every other live model as a
  // different-model fallback rather than repeating the failed configuration.
  const ordered = [take(item => item.geminiFlash), take(item => item.deepseekV4Flash), ...candidates].filter(Boolean);
  return { originalModel, originalKey, candidates: ordered };
}

module.exports = { unwrapModelPayload, modelKey, buildPerspectiveRetryModelPlan };
