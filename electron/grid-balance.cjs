const fields = [];
function number(key, label, value, min, max, step = 1, group = "基础") {
  fields.push(Object.freeze({ key, label, value, min, max, step, group, type: "number" }));
}
number("marchSeconds", "普通地块行军秒数", 15, 0.1, 86400, 0.1, "行军");
number("ownMarchRatio", "己方领地耗时与费用比例", 0.25, 0.01, 1, 0.01, "行军");
number("marchBaseGold", "每格基础金币", 1, 0, 10000, 1, "行军");
number("marchSoldiersPerGold", "每增加一金币对应士兵数", 10, 1, 1000000, 1, "行军");
number("marchGeneralGold", "每名将领每格金币", 2, 0, 10000, 1, "行军");
number("miningSeconds", "采集耗时（秒）", 600, 1, 86400, 1, "采集");
number("miningCooldownMinMinutes", "最低资源级冷却（分钟）", 54, 0, 10080, 1, "采集");
number("miningCooldownMaxMinutes", "最高资源级冷却（分钟）", 216, 0, 10080, 1, "采集");
number("miningConcurrent", "同时采集领地上限", 3, 1, 4096, 1, "采集");
number("miningYieldRatio", "采集金币倍率", 1, 0.01, 100, 0.01, "采集");
number("trainingBaseSeconds", "练兵基础秒数", 5, 0, 86400, 0.1, "练兵");
number("trainingSoldierSeconds", "每兵增加秒数", 0.5, 0.01, 3600, 0.01, "练兵");
number("trainingSoldierGold", "每兵金币", 2, 0, 10000, 1, "练兵");
number("battleDiscoveryMin", "攻打最低发现概率", 0.019, 0, 1, 0.0001, "概率");
number("battleDiscoveryMax", "攻打最高发现概率", 0.24, 0, 1, 0.0001, "概率");
number("trainingDiscoveryInitial", "练兵初始发现概率", 0.000001, 0, 1, 0.000001, "概率");
number("trainingDiscoveryPity", "练兵保底士兵数", 15000, 1, 1000000, 1, "概率");
number("trainingDiscoveryCurve", "练兵概率曲线指数", 12, 1, 30, 0.1, "概率");
number("deploymentDiscoveryMultiplier", "每名部署将领发现倍率", 2, 1, 10, 0.1, "概率");
number("femaleGeneralChance", "不限性别时女性将领概率", 0.5, 0, 1, 0.01, "概率");
number("loserCasualtyRatio", "败方战力对应伤亡比例", 0.8, 0, 1, 0.01, "战斗");
number("winnerCasualtyRatio", "胜方伤亡系数与战力上限比例", 0.9, 0, 1, 0.01, "战斗");
number("initialTreasureCount", "开局普通素材数量", 240, 0, 4096, 1, "初始");
number("playerPowerMin", "新玩家初始战力下限", 80, 1, 100000, 1, "初始");
number("playerPowerMax", "新玩家初始战力上限", 120, 1, 100000, 1, "初始");
number("generalPowerMin", "新将领初始战力下限", 125, 1, 100000, 1, "初始");
number("generalPowerMax", "新将领初始战力上限", 175, 1, 100000, 1, "初始");
number("startingGold", "新玩家初始金币", 500, 0, 100000000, 1, "初始");
number("initialGarrisonRatio", "初始驻军占上限比例", 0.5, 0, 1, 0.01, "初始");
number("marketCooldownMinutes", "下架后再次出售冷却（分钟）", 360, 0, 10080, 1, "冷却");
number("dialogueCooldownSeconds", "将领对话冷却（秒）", 15, 0, 3600, 1, "冷却");
number("battleExperienceMax", "战斗经验最高比例", 0.48, 0, 1, 0.01, "经验");
number("battleExperienceMin", "战斗经验最低比例", 0.1, 0, 1, 0.01, "经验");
number("battleExperienceDifference", "战力差经验衰减尺度", 250, 1, 1000000, 1, "经验");
number("marchExperienceDivisor", "行军攒满经验所需格数", 12000, 1, 1000000, 1, "经验");
number("playerCultivationGoldRatio", "玩家修炼金币倍率", 2.5, 0.1, 100, 0.1, "修炼");
number("playerCultivationPowerRatio", "玩家修炼战力倍率", 1, 0.1, 10, 0.1, "修炼");
number("cultivationRandomMin", "修炼随机倍率下限", 0.5, 0.01, 10, 0.01, "修炼");
number("cultivationRandomMax", "修炼随机倍率上限", 1.5, 0.01, 10, 0.01, "修炼");
number("deployedTalentRatio", "部署天赋效果倍率", 1.25, 0.1, 10, 0.05, "天赋");
number("materialGrowthRandomMin", "素材成长随机倍率下限", 0.9, 0.1, 5, 0.01, "天赋");
number("materialGrowthRandomMax", "素材成长随机倍率上限", 1.1, 0.1, 5, 0.01, "天赋");
for (const [id, label, weight, progress] of [
  ["white", "白", 64000, 8], ["green", "绿", 24000, 20], ["blue", "蓝", 9000, 42],
  ["purple", "紫", 2770, 78], ["gold", "金", 200, 135], ["red", "红", 30, null]
]) {
  number(`talentWeight_${id}`, `${label}色初始天赋权重`, weight, 0, 1000000, 1, "天赋");
  if (progress != null) number(`materialProgress_${id}`, `${label}色素材成长量`, progress, 1, 1000, 1, "天赋");
  if (progress != null) number(`treasureWeight_${id}`, `${label}色普通散落权重`, { white: 30, green: 30, blue: 22, purple: 12, gold: 6 }[id], 0, 1000000, 1, "概率");
}
for (let i = 0; i <= 5; i += 1) number(`defenseBonus_${i}`, `修炼${i}次部署防御加成`, [.05, .1, .2, .4, .6, .9][i], 0, 10, 0.01, "战斗");
for (let i = 0; i < 5; i += 1) {
  const n = i + 1;
  number(`cultivationGoldMin_${i}`, `第${n}次修炼最低金币`, [500, 1200, 3000, 7000, 16000][i], 1, 100000000, 1, "修炼");
  number(`cultivationGoldMax_${i}`, `第${n}次修炼最高金币`, [8000, 18000, 45000, 100000, 240000][i], 1, 100000000, 1, "修炼");
  number(`cultivationGainMin_${i}`, `第${n}次最低战力增幅比例`, 0.05, 0, 10, 0.01, "修炼");
  number(`cultivationGainMax_${i}`, `第${n}次最高战力增幅比例`, 1, 0, 10, 0.01, "修炼");
  number(`trainingExperienceMinutes_${i}`, `第${n}次修炼练兵满经验分钟`, [30, 90, 180, 360, 720][i], 1, 100800, 1, "经验");
  number(`idleExperienceMinutes_${i}`, `第${n}次修炼部署满经验分钟`, [180, 540, 1080, 2160, 4320][i], 1, 100800, 1, "经验");
}
fields.push(Object.freeze({ key: "dailyRedTime", label: "每日红色素材刷新时间（北京时间）", type: "time", value: "20:30", group: "每日刷新" }));
number("dailyRedMin", "每日红色素材最少数量", 1, 1, 20, 1, "每日刷新");
number("dailyRedMax", "每日红色素材最多数量", 2, 1, 20, 1, "每日刷新");
const BALANCE_FIELDS = Object.freeze(fields);
const BALANCE_DEFAULTS = Object.freeze(Object.fromEntries(fields.map(f => [f.key, f.value])));
function balanceValue(state, key) {
  return state?.balance?.[key] ?? BALANCE_DEFAULTS[key];
}
function normalizeBalance(value = {}, strict = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("平衡设置格式无效");
  if (strict && Object.keys(value).some(key => !Object.hasOwn(BALANCE_DEFAULTS, key))) throw new Error("存在未知平衡设置");
  const result = {};
  for (const field of fields) {
    const raw = value[field.key] ?? field.value;
    const valid = field.type === "time" ? typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw)
      : typeof raw === "number" && Number.isFinite(raw) && raw >= field.min && raw <= field.max
        && (field.step !== 1 || Number.isSafeInteger(raw));
    if (!valid && strict) throw new Error(`${field.label}超出有效范围`);
    result[field.key] = valid ? raw : field.value;
  }
  const pairs = [
    ["battleDiscoveryMin", "battleDiscoveryMax"], ["playerPowerMin", "playerPowerMax"],
    ["generalPowerMin", "generalPowerMax"], ["battleExperienceMin", "battleExperienceMax"],
    ["cultivationRandomMin", "cultivationRandomMax"], ["materialGrowthRandomMin", "materialGrowthRandomMax"],
    ["miningCooldownMinMinutes", "miningCooldownMaxMinutes"], ["dailyRedMin", "dailyRedMax"],
    ...Array.from({ length: 5 }, (_, i) => [`cultivationGoldMin_${i}`, `cultivationGoldMax_${i}`]),
    ...Array.from({ length: 5 }, (_, i) => [`cultivationGainMin_${i}`, `cultivationGainMax_${i}`])
  ];
  for (const [min, max] of pairs) if (result[min] > result[max]) {
    if (strict) throw new Error("平衡设置下限大于上限");
    result[min] = BALANCE_DEFAULTS[min]; result[max] = BALANCE_DEFAULTS[max];
  }
  for (const prefix of ["talentWeight_", "treasureWeight_"]) {
    const weights = fields.filter(f => f.key.startsWith(prefix));
    if (!weights.some(f => result[f.key] > 0)) {
      if (strict) throw new Error("天赋或素材至少保留一种有效等级");
      for (const f of weights) result[f.key] = f.value;
    }
  }
  return result;
}
module.exports = { BALANCE_FIELDS, BALANCE_DEFAULTS, balanceValue, normalizeBalance };
