#!/usr/bin/env node

/* Generate the reference table from the same catalog used by the game. */
const fs = require("node:fs");
const path = require("node:path");
const talents = require("../electron/grid-talents.cjs");
const game = require("../electron/grid-world-game.cjs");

const categoryLabels = Object.freeze({
  march: "行军",
  combat: "战斗",
  mining: "开采",
  training: "练兵",
  cultivation: "修炼",
  discovery: "将领发掘",
  deployment: "部署"
});
const actionLabels = Object.freeze({
  march: "行军",
  combat: "战斗",
  mining: "开采",
  training: "练兵",
  cultivation: "修炼",
  discovery: "发掘"
});
const keyLabels = Object.freeze({
  marchDuration: "行军时长",
  marchCost: "行军金币消耗",
  combatPower: "综合战力",
  attackPower: "进攻战力",
  defensePower: "防守战力",
  miningDuration: "开采时长",
  miningYield: "开采产量",
  trainingDuration: "练兵时长",
  trainingCost: "练兵消耗",
  trainingYield: "练兵产量",
  cultivationCost: "修炼消耗",
  cultivationPower: "修炼战力",
  discoveryChance: "发掘概率"
});
const scopeLabels = Object.freeze({
  carried: "随行将领",
  "own-tile": "部署地",
  "neighbor-allied": "相邻友方区域",
  "neighbor-hostile": "相邻敌对/中立区域",
  "enemy-neighbor": "敌方相邻区域"
});
const terrainLabels = Object.freeze({
  plain: "平原",
  forest: "森林",
  mountain: "山地",
  river: "河流",
  coast: "海岸"
});
const opLabels = Object.freeze({
  "resource-rank-gte": (value) => `资源评级 >= ${value}`,
  "resource-rank-lte": (value) => `资源评级 <= ${value}`,
  "population-gte": (value) => `人口 >= ${value}`,
  "population-lte": (value) => `人口 <= ${value}`,
  "army-size-gte": (value) => `行军士兵 >= ${value}`,
  "army-size-lte": (value) => `行军士兵 <= ${value}`,
  "neutral-is": (value) => value ? "目标为中立地块" : "目标不是中立地块",
  "attacking-is": (value) => value ? "正在进攻" : "非进攻行军",
  "discovery-kind-is": (value) => value === "attack" ? "攻打获得将领判定" : value === "training" ? "练兵获得将领判定" : `发掘类型为 ${value}`,
  "hour-between": (start, end) => `UTC 小时 ${start}:00-${end}:00${Number(start) > Number(end) ? "（跨午夜）" : ""}`
});

function percent(value) {
  const n = Number(value) * 100;
  const formatted = Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `${n >= 0 ? "+" : ""}${formatted}%`;
}

function conditionText(condition) {
  if (!condition || typeof condition !== "object") return "";
  if (condition.op === "terrain-in") return `地形为 ${condition.values.map((value) => terrainLabels[value] || value).join("/" )}`;
  const formatter = opLabels[condition.op];
  if (!formatter) return `${condition.op}=${String(condition.value ?? "")}`;
  return condition.op === "hour-between"
    ? formatter(condition.start, condition.end)
    : formatter(condition.value);
}

function effectText(item) {
  const direction = Number(item.scale) >= 0 ? "提高" : "降低";
  const amount = percent(Math.abs(Number(item.scale))).replace(/^\+/, "");
  const conditions = Array.isArray(item.when) && item.when.length
    ? `；条件：${item.when.map(conditionText).join("、")}`
    : "";
  return `${scopeLabels[item.scope] || item.scope} ${actionLabels[item.action] || item.action}时，${keyLabels[item.key] || item.key}${direction}${amount} × 天赋潜能${conditions}`;
}

function rarityText() {
  return talents.RARITIES.map((rarity) => {
    const min = (Number(rarity.potencyMin) * 100).toFixed(2);
    const max = (Number(rarity.potencyMax) * 100).toFixed(2);
    return `${rarity.label}（${rarity.weight}，潜能 ${min}-${max}%）`;
  }).join("；");
}

function materialText() {
  return talents.MATERIALS.map((item) => {
    const action = item.mode === "ascend" ? "升至红色区间" : item.mode === "reroll" ? "重抽定义" : `进度基础 +${item.progress}`;
    return `${item.id} ${item.label}（${action}）`;
  }).join("；");
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\\.$/, "");
}

function code(value) {
  return `\`${String(value)}\``;
}

function buildDocument() {
  const catalog = talents.TALENT_CATALOG;
  const counts = Object.fromEntries(Object.keys(categoryLabels).map((category) => [category, catalog.filter((item) => item.category === category).length]));
  const lines = [
    "# 猎艳疆土全天赋表",
    "",
    `本表由 ${code("scripts/generate-grid-talent-catalog.cjs")} 从运行时 ${code("electron/grid-talents.cjs")} 直接生成。当前目录共 **${catalog.length}** 条定义；ID、条件和数值以代码为准，避免说明文档与游戏分叉。`,
    "",
    "## 统一规则",
    "",
    `- 分类数量：${Object.entries(counts).map(([key, value]) => `${categoryLabels[key]} ${value}`).join("；")}。`,
    `- 天赋效果按潜能值加算；所有非“随行将领”作用域统一乘以部署倍率 **${formatNumber(talents.DEPLOYED_EFFECT_MULTIPLIER)}**，随行将领不乘该倍率。`,
    `- 全局修正上限：\`${JSON.stringify(talents.MODIFIER_LIMITS)}\`；发掘概率修正以百分点加到基础概率后再限制。`,
    `- 稀有度：${rarityText()}。`,
    `- 天材地宝：${materialText()}。`,
    `- 发现判定专用条件“攻打获得将领判定”和“练兵获得将领判定”分别对应 ${code("discoveryKind=attack")} 与 ${code("discoveryKind=training")}；两类判定不会互相套用。`,
    `- 练兵每名士兵基础发掘概率为 ${percent(game.TRAINING_GENERAL_DISCOVERY_PER_SOLDIER)}；每名部署将领使练兵判定倍率翻倍，倍率为 2^部署将领数。`,
    `- 行军基础速度为每格 ${formatNumber(game.MARCH_MS_PER_CELL / 1000)} 秒；资源采集评级倍率为 ${game.MINING_GRADE_YIELD_MULTIPLIERS.map((value, index) => `${index + 1}:${formatNumber(value)}x`).join("、")}。`,
    "",
    "## 字段说明",
    "",
    "效果中的“+/-百分比 × 天赋潜能”表示定义系数；实际百分比还会乘该将领实例的潜能值，再按统一上限裁剪。作用域“部署地/相邻区域”只在将领确实部署时生效。",
    "",
    "## 完整目录",
    "",
    "| # | 分类 | ID | 名称 | 运行时效果 |",
    "| ---: | --- | --- | --- | --- |"
  ];
  catalog.forEach((item, index) => {
    const effects = item.effects.map(effectText).join("<br>");
    lines.push(`| ${index + 1} | ${categoryLabels[item.category] || item.category} | ${code(item.id)} | ${item.name} | ${effects} |`);
  });
  lines.push(
    "",
    "## 发现类天赋快速索引",
    "",
    "以下天赋的条件中含有发掘类型限定，只有对应事件会读取：",
    "",
    `- 攻打判定：${catalog.filter((item) => item.effects.some((effect) => effect.when?.some((condition) => condition.op === "discovery-kind-is" && condition.value === "attack"))).map((item) => code(item.name)).join("、")}。`,
    `- 练兵判定：${catalog.filter((item) => item.effects.some((effect) => effect.when?.some((condition) => condition.op === "discovery-kind-is" && condition.value === "training"))).map((item) => code(item.name)).join("、")}。`,
    "",
    "## 维护",
    "",
    "修改天赋定义后运行：",
    "",
    "```powershell",
    "node scripts/generate-grid-talent-catalog.cjs",
    "```",
    "",
    "脚本会覆盖本文件，不会修改游戏卡、版本号或平台配置。",
    ""
  );
  return `${lines.join("\n")}\n`;
}

const outputPath = path.resolve(__dirname, "..", "docs", "猎艳疆土全天赋表.md");
fs.writeFileSync(outputPath, buildDocument(), "utf8");
console.log(`wrote ${path.relative(process.cwd(), outputPath)} (${talents.TALENT_CATALOG.length} talents)`);
