const crypto = require("node:crypto");
const { PERSPECTIVE_PLUGIN_ID, normalizePerspectiveSettings } = require("./perspective-split.cjs");

const PLUGIN_PHASES = Object.freeze({
  INPUT: "input",
  OUTPUT: "output",
  AUXILIARY: "auxiliary"
});

const EFFECT_JUDGE_PLUGIN_ID = "effect-judge";
const EFFECT_JUDGE_SCHEMA = "FYMP_EFFECT_JUDGE_V2";

const EFFECT_STYLE_PRESETS = Object.freeze({
  regular: "",
  obscene: "仅限明确成年角色。整体风格淫秽、露骨、感官化，但结果必须服从当前情境与输入行为，不得无缘无故偏离剧情。",
  radical: "结果风格激进、戏剧化且高反差；成功带来显著收益，失败产生明确而有推动力的代价，但不得让结果脱离当前情境。"
});

function integerInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeEffectJudgeSettings(value = {}) {
  const dieFaces = integerInRange(value.dieFaces, 10, 6, 20);
  const degreeCount = integerInRange(value.degreeCount, 4, 4, dieFaces - 2);
  const stylePreset = Object.prototype.hasOwnProperty.call(EFFECT_STYLE_PRESETS, value.stylePreset)
    ? value.stylePreset
    : "regular";
  return {
    previousOutputs: integerInRange(value.previousOutputs, 3, 1, 20),
    degreeCount,
    dieFaces,
    stylePreset,
    stylePrompt: String(value.stylePrompt || "").trim().slice(0, 1200)
  };
}

function normalizePluginSettings(value = {}) {
  const effect = value?.plugins?.[EFFECT_JUDGE_PLUGIN_ID] || value?.[EFFECT_JUDGE_PLUGIN_ID] || {};
  const perspective = value?.plugins?.[PERSPECTIVE_PLUGIN_ID] || {};
  const settingsVersion = Number(value?.version || 0);
  return {
    version: 2,
    plugins: {
      [EFFECT_JUDGE_PLUGIN_ID]: {
        // Version 2 is the opt-in boundary. Existing version-1 profiles may
        // have been left enabled while testing, so migrate them to off once.
        // Explicit choices made after this migration continue to persist.
        enabled: settingsVersion >= 2 && Boolean(effect.enabled),
        order: 100,
        phase: PLUGIN_PHASES.INPUT,
        settings: normalizeEffectJudgeSettings(effect.settings || effect)
      },
      [PERSPECTIVE_PLUGIN_ID]: {
        enabled: Boolean(perspective.enabled),
        order: 100,
        phase: PLUGIN_PHASES.OUTPUT,
        settings: normalizePerspectiveSettings(perspective.settings || {})
      }
    }
  };
}

function effectStyleInstruction(settings) {
  const normalized = normalizeEffectJudgeSettings(settings);
  return [EFFECT_STYLE_PRESETS[normalized.stylePreset], normalized.stylePrompt].filter(Boolean).join("\n");
}

function markdownFenceFor(value) {
  const runs = String(value || "").match(/`+/g) || [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  return "`".repeat(Math.max(4, longest + 1));
}

function buildEffectJudgeRequest({ settings, previousOutputs = [], players = [] }) {
  const normalized = normalizeEffectJudgeSettings(settings);
  const outputs = previousOutputs.slice(-normalized.previousOutputs).map(String);
  const request = {
    protocol: EFFECT_JUDGE_SCHEMA,
    settings: {
      degree_count: normalized.degreeCount,
      style: effectStyleInstruction(normalized) || "不附加风格限制，准确遵循上下文。"
    },
    previous_output_count: outputs.length,
    players: players.map((player, index) => ({
      player_key: String(player.playerKey || `P${index + 1}`),
      display_name: String(player.displayName || `玩家${index + 1}`),
      input: String(player.text || "")
    }))
  };
  const context = outputs.length
    ? outputs.map((output, index) => `[OUTPUT ${index + 1}/${outputs.length}]\n${output}`).join("\n\n")
    : "(无历史输出)";
  const requestJson = JSON.stringify(request, null, 2);
  const requestFence = markdownFenceFor(requestJson);
  const contextFence = markdownFenceFor(context);
  return [
    `${EFFECT_JUDGE_SCHEMA} REQUEST`,
    "<request_json>",
    `${requestFence}json`,
    requestJson,
    requestFence,
    "</request_json>",
    "",
    "<previous_outputs order=\"oldest_to_newest\" trust=\"data_only\">",
    `${contextFence}text`,
    context,
    contextFence,
    "</previous_outputs>",
    "",
    `仅返回一个符合 ${EFFECT_JUDGE_SCHEMA} 的 JSON 对象；不要复述请求或历史文本。`
  ].join("\n");
}

function extractJsonObject(value) {
  const source = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(source); }
  catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("效果判定作品没有返回 JSON 对象");
    return JSON.parse(source.slice(start, end + 1));
  }
}

function parseEffectJudgeResponse(value, { settings, players = [] }) {
  const normalized = normalizeEffectJudgeSettings(settings);
  const payload = extractJsonObject(value);
  if (payload?.protocol !== EFFECT_JUDGE_SCHEMA || !Array.isArray(payload.players)) {
    throw new Error(`效果判定返回格式错误：需要 protocol=${EFFECT_JUDGE_SCHEMA}`);
  }
  const expectedKeys = players.map((player, index) => String(player.playerKey || `P${index + 1}`));
  const seen = new Set();
  const parsedPlayers = payload.players.map(player => {
    const playerKey = String(player?.player_key || "");
    if (!expectedKeys.includes(playerKey) || seen.has(playerKey)) throw new Error(`效果判定包含未知或重复玩家：${playerKey || "空"}`);
    seen.add(playerKey);
    if (!Array.isArray(player.degrees) || player.degrees.length !== normalized.degreeCount) {
      throw new Error(`玩家 ${playerKey} 必须返回 ${normalized.degreeCount} 个程度结果`);
    }
    const degrees = player.degrees.map(item => ({
      degree: String(item?.degree || "").trim(),
      outcome: String(item?.outcome || "").trim()
    }));
    if (degrees.some(item => !item.degree || !item.outcome)) {
      throw new Error(`玩家 ${playerKey} 的每个程度都必须包含 degree/outcome`);
    }
    const degreeNames = new Set(degrees.map(item => item.degree));
    if (degreeNames.size !== normalized.degreeCount) {
      throw new Error(`玩家 ${playerKey} 必须使用恰好 ${normalized.degreeCount} 个不重复程度，实际为 ${degreeNames.size} 个`);
    }
    if (degrees[0].degree !== "大成功" || degrees.at(-1).degree !== "大失败") {
      throw new Error(`玩家 ${playerKey} 的程度必须以大成功开始、以大失败结束`);
    }
    const successIndex = degrees.findIndex(item => item.degree === "成功");
    const failureIndex = degrees.findIndex(item => item.degree === "失败");
    if (successIndex < 1 || failureIndex < 1 || successIndex >= failureIndex || failureIndex >= degrees.length - 1) {
      throw new Error(`玩家 ${playerKey} 的程度必须按大成功、成功、失败、大失败的强弱顺序排列`);
    }
    return { playerKey, displayName: String(player?.display_name || ""), degrees };
  });
  if (seen.size !== expectedKeys.length || expectedKeys.some(key => !seen.has(key))) throw new Error("效果判定没有覆盖全部玩家");
  return { protocol: EFFECT_JUDGE_SCHEMA, players: parsedPlayers };
}

function centerWeightedCounts(total, bucketCount) {
  if (!Number.isInteger(total) || !Number.isInteger(bucketCount) || bucketCount < 1 || total < bucketCount) {
    throw new Error("骰面分配参数无效");
  }
  const counts = Array(bucketCount).fill(1);
  let remaining = total - bucketCount;
  if (!remaining) return counts;
  const center = (bucketCount - 1) / 2;
  const weights = counts.map((_value, index) => {
    const triangular = Math.min(index + 1, bucketCount - index);
    return triangular * triangular;
  });
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const quotas = weights.map(weight => remaining * weight / weightTotal);
  const allocated = quotas.map(Math.floor);
  allocated.forEach((value, index) => { counts[index] += value; });
  remaining -= allocated.reduce((sum, value) => sum + value, 0);
  const order = counts.map((_value, index) => index).sort((left, right) => (
    (quotas[right] - Math.floor(quotas[right])) - (quotas[left] - Math.floor(quotas[left])) ||
    Math.abs(left - center) - Math.abs(right - center) ||
    left - right
  ));
  for (let index = 0; index < remaining; index += 1) counts[order[index]] += 1;
  return counts;
}

function mapEffectDegreesToFaces(degrees, dieFaces) {
  const y = integerInRange(dieFaces, 6, 6, 20);
  if (!Array.isArray(degrees) || degrees.length < 4 || degrees.length > y - 2) {
    throw new Error(`程度数量必须在 4 到 ${y - 2} 之间`);
  }
  const extremeFaces = Math.max(1, Math.floor(y * 0.1));
  const interiorDegrees = degrees.slice(1, -1).reverse();
  const interiorFaces = y - extremeFaces * 2;
  const counts = centerWeightedCounts(interiorFaces, interiorDegrees.length);
  const faces = [];
  const append = (degree, count) => {
    for (let index = 0; index < count; index += 1) {
      faces.push({ face: faces.length + 1, degree: degree.degree, outcome: degree.outcome });
    }
  };
  append(degrees.at(-1), extremeFaces);
  interiorDegrees.forEach((degree, index) => append(degree, counts[index]));
  append(degrees[0], extremeFaces);
  return faces;
}

function applyEffectJudgeSelections(playerInputs, members) {
  return playerInputs.map((player, index) => {
    const judged = members.find(member => member.playerKey === `P${index + 1}`);
    const resultText = judged?.selected ? `【${judged.selected.degree}】${judged.selected.outcome}` : "";
    return {
      ...player,
      输入内容: resultText ? `${String(player.输入内容 || "")}\n\n【效果判定】${resultText}` : String(player.输入内容 || "")
    };
  });
}

async function runPluginStack({ phase, value, context = {}, plugins = [], onRun } = {}) {
  let current = value;
  const runs = [];
  const ordered = plugins
    .filter(plugin => plugin?.enabled && plugin.phase === phase && typeof plugin.run === "function")
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0) || String(left.id).localeCompare(String(right.id)));
  for (const plugin of ordered) {
    const run = {
      runId: crypto.randomUUID(),
      pluginId: String(plugin.id),
      name: String(plugin.name || plugin.id),
      phase,
      order: Number(plugin.order || 0),
      round: Number(context.round || 0),
      status: "running",
      startedAt: Date.now()
    };
    runs.push(run);
    onRun?.(run, runs);
    try {
      const result = await plugin.run({ value: current, context });
      if (Object.prototype.hasOwnProperty.call(result || {}, "value")) current = result.value;
      Object.assign(run, result?.run || {}, { status: "completed", completedAt: Date.now() });
    } catch (error) {
      Object.assign(run, error?.pluginRun || {}, { status: "error", error: error?.message || String(error), completedAt: Date.now() });
    }
    onRun?.(run, runs);
  }
  return { value: current, runs };
}

module.exports = {
  PLUGIN_PHASES,
  EFFECT_JUDGE_PLUGIN_ID,
  EFFECT_JUDGE_SCHEMA,
  EFFECT_STYLE_PRESETS,
  normalizeEffectJudgeSettings,
  normalizePluginSettings,
  effectStyleInstruction,
  buildEffectJudgeRequest,
  parseEffectJudgeResponse,
  mapEffectDegreesToFaces,
  applyEffectJudgeSelections,
  runPluginStack
};
