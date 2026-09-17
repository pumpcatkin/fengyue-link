const crypto = require("node:crypto");

const TALENT_SCHEMA = "fyow.grid-talent/1";
const RESOURCE_GRADES = Object.freeze(["D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S-", "S", "S+"]);
const MODIFIER_KEYS = Object.freeze([
  "marchDuration", "marchCost", "combatPower", "attackPower", "defensePower",
  "miningDuration", "miningYield", "trainingDuration", "trainingCost", "trainingYield",
  "cultivationCost", "cultivationPower", "discoveryChance"
]);

const RARITIES = Object.freeze([
  Object.freeze({ id: "white", label: "白", rank: 0, weight: 560, progressMin: 0, progressMax: 99, potencyMin: 0.002, potencyMax: 0.006 }),
  Object.freeze({ id: "green", label: "绿", rank: 1, weight: 250, progressMin: 100, progressMax: 219, potencyMin: 0.008, potencyMax: 0.015 }),
  Object.freeze({ id: "blue", label: "蓝", rank: 2, weight: 110, progressMin: 220, progressMax: 359, potencyMin: 0.018, potencyMax: 0.03 }),
  Object.freeze({ id: "purple", label: "紫", rank: 3, weight: 50, progressMin: 360, progressMax: 519, potencyMin: 0.035, potencyMax: 0.055 }),
  Object.freeze({ id: "gold", label: "金", rank: 4, weight: 25, progressMin: 520, progressMax: 699, potencyMin: 0.065, potencyMax: 0.09 }),
  Object.freeze({ id: "red", label: "红", rank: 5, weight: 5, progressMin: 700, progressMax: 1000, potencyMin: 0.11, potencyMax: 0.16 })
]);
const RARITY_BY_ID = Object.freeze(Object.fromEntries(RARITIES.map(item => [item.id, item])));

const MATERIALS = Object.freeze([
  Object.freeze({ id: "white", label: "白色天赋素材", progress: 8, mode: "grow" }),
  Object.freeze({ id: "green", label: "绿色天赋素材", progress: 20, mode: "grow" }),
  Object.freeze({ id: "blue", label: "蓝色天赋素材", progress: 42, mode: "grow" }),
  Object.freeze({ id: "purple", label: "紫色天赋素材", progress: 78, mode: "grow" }),
  Object.freeze({ id: "gold", label: "金色天赋素材", progress: 135, mode: "grow" }),
  Object.freeze({ id: "red-ascend", label: "赤曜升格素材", progress: 0, mode: "ascend" }),
  Object.freeze({ id: "red-reroll", label: "赤曜洗髓素材", progress: 0, mode: "reroll" })
]);
const MATERIAL_BY_ID = Object.freeze(Object.fromEntries(MATERIALS.map(item => [item.id, item])));

const MODIFIER_LIMITS = Object.freeze({
  marchDuration: [-0.45, 0.15], marchCost: [-0.45, 0.15],
  combatPower: [-0.2, 0.6], attackPower: [-0.2, 0.6], defensePower: [-0.2, 0.6],
  miningDuration: [-0.45, 0.15], miningYield: [-0.2, 0.6],
  trainingDuration: [-0.45, 0.15], trainingCost: [-0.45, 0.15], trainingYield: [-0.2, 0.6],
  cultivationCost: [-0.45, 0.15], cultivationPower: [-0.2, 0.6],
  discoveryChance: [-0.03, 0.12]
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round6(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function hash(seed, ...parts) {
  return crypto.createHash("sha256").update([String(seed ?? ""), ...parts.map(part => String(part ?? ""))].join("\0")).digest();
}

function hashUnit(seed, ...parts) {
  return hash(seed, ...parts).readUInt32BE(0) / 0x100000000;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function effect(key, scope, action, scale = 1, when = []) {
  if (!MODIFIER_KEYS.includes(key)) throw new Error(`未知天赋修正项：${key}`);
  return { key, scope, action, scale, when };
}

const C = Object.freeze({
  terrain: (...values) => ({ op: "terrain-in", values }),
  resourceAtLeast: value => ({ op: "resource-rank-gte", value }),
  resourceAtMost: value => ({ op: "resource-rank-lte", value }),
  populationAtLeast: value => ({ op: "population-gte", value }),
  populationAtMost: value => ({ op: "population-lte", value }),
  neutral: value => ({ op: "neutral-is", value }),
  attacking: value => ({ op: "attacking-is", value }),
  armyAtLeast: value => ({ op: "army-size-gte", value }),
  armyAtMost: value => ({ op: "army-size-lte", value }),
  hour: (start, end) => ({ op: "hour-between", start, end })
});

const definitions = [];
function add(id, name, category, effects) {
  definitions.push({ id, name, category, effects });
}

// Marching: route, destination, force size, attack posture and time each have distinct uses.
add("swift-column", "疾行纵队", "march", [effect("marchDuration", "carried", "march", -1)]);
add("lean-baggage", "轻装辎重", "march", [effect("marchCost", "carried", "march", -1)]);
add("forest-pathfinder", "林径先导", "march", [effect("marchDuration", "carried", "march", -1, [C.terrain("forest")])]);
add("mountain-guide", "山道识途", "march", [effect("marchDuration", "carried", "march", -1, [C.terrain("mountain")])]);
add("river-quartermaster", "临水转运", "march", [effect("marchCost", "carried", "march", -1, [C.terrain("river", "coast")])]);
add("night-march", "衔枚夜行", "march", [effect("marchDuration", "carried", "march", -1, [C.hour(20, 5)])]);
add("day-supply", "昼行给养", "march", [effect("marchCost", "carried", "march", -1, [C.hour(6, 17)])]);
add("vanguard-step", "先锋急进", "march", [effect("marchDuration", "carried", "march", -0.85, [C.attacking(true)])]);
add("peaceful-transit", "安境通行", "march", [effect("marchCost", "carried", "march", -0.9, [C.attacking(false)])]);
add("small-unit-drill", "小队操典", "march", [effect("marchDuration", "carried", "march", -0.8, [C.armyAtMost(300)])]);
add("grand-logistics", "大军转饷", "march", [effect("marchCost", "carried", "march", -0.8, [C.armyAtLeast(2000)])]);
add("home-road", "本境驰道", "march", [effect("marchDuration", "own-tile", "march", -0.9)]);
add("relay-post", "邻境驿传", "march", [effect("marchDuration", "neighbor-allied", "march", -0.7)]);
add("border-forage", "边地截粮", "march", [effect("marchCost", "enemy-neighbor", "march", 0.75)]);
add("neutral-survey", "无主地勘路", "march", [effect("marchDuration", "neighbor-hostile", "march", -0.8, [C.neutral(true)])]);
add("rich-road-toll", "富地折券", "march", [effect("marchCost", "own-tile", "march", -0.75, [C.resourceAtLeast("A-")])]);
add("populous-staging", "众邑接力", "march", [effect("marchDuration", "neighbor-allied", "march", -0.65, [C.populationAtLeast(6000)])]);
add("waste-route", "荒径省驮", "march", [effect("marchCost", "neighbor-hostile", "march", -0.7, [C.populationAtMost(1500)])]);

// Combat: general strength, attack and defence remain separate modifier channels.
add("battle-instinct", "临阵机断", "combat", [effect("combatPower", "carried", "combat", 1)]);
add("spearhead", "破阵锋芒", "combat", [effect("attackPower", "carried", "combat", 1, [C.attacking(true)])]);
add("rearguard", "殿军持重", "combat", [effect("defensePower", "carried", "combat", 1, [C.attacking(false)])]);
add("forest-ambush", "林间伏击", "combat", [effect("attackPower", "carried", "combat", 0.9, [C.terrain("forest"), C.attacking(true)])]);
add("mountain-wall", "依山成垒", "combat", [effect("defensePower", "own-tile", "combat", 0.95, [C.terrain("mountain")])]);
add("river-crossing", "济水争先", "combat", [effect("attackPower", "neighbor-hostile", "combat", 0.8, [C.terrain("river", "coast")])]);
add("plain-formation", "平野布阵", "combat", [effect("combatPower", "carried", "combat", 0.85, [C.terrain("plain")])]);
add("night-raid", "夜袭营垒", "combat", [effect("attackPower", "carried", "combat", 0.9, [C.hour(20, 4)])]);
add("dawn-watch", "破晓严阵", "combat", [effect("defensePower", "own-tile", "combat", 0.85, [C.hour(5, 8)])]);
add("few-against-many", "寡兵坚志", "combat", [effect("combatPower", "carried", "combat", 0.9, [C.armyAtMost(500)])]);
add("mass-formation", "万众一阵", "combat", [effect("combatPower", "carried", "combat", 0.75, [C.armyAtLeast(3000)])]);
add("neutral-pacifier", "拓土安民", "combat", [effect("attackPower", "neighbor-hostile", "combat", 0.8, [C.neutral(true)])]);
add("city-defender", "大邑固守", "combat", [effect("defensePower", "own-tile", "combat", 0.9, [C.populationAtLeast(7000)])]);
add("hamlet-shield", "小邑相援", "combat", [effect("defensePower", "neighbor-allied", "combat", 0.75, [C.populationAtMost(2000)])]);
add("rich-land-contest", "膏腴必争", "combat", [effect("attackPower", "neighbor-hostile", "combat", 0.75, [C.resourceAtLeast("A")])]);
add("poor-land-tenacity", "瘠土韧守", "combat", [effect("defensePower", "own-tile", "combat", 0.8, [C.resourceAtMost("C")])]);
add("allied-screen", "邻军掩护", "combat", [effect("defensePower", "neighbor-allied", "combat", 0.8)]);
add("border-pressure", "临境威压", "combat", [effect("combatPower", "enemy-neighbor", "combat", -0.8)]);
add("garrison-command", "镇地军令", "combat", [effect("combatPower", "own-tile", "combat", 0.9)]);
add("mobile-reserve", "随军预备", "combat", [effect("defensePower", "carried", "combat", 0.7), effect("attackPower", "carried", "combat", 0.35, [C.armyAtLeast(1000)])]);
add("shock-and-hold", "先登后据", "combat", [effect("attackPower", "carried", "combat", 0.65, [C.attacking(true)]), effect("defensePower", "carried", "combat", 0.35, [C.armyAtMost(1200)])]);
add("border-fortifier", "边垒经营", "combat", [effect("defensePower", "neighbor-allied", "combat", 0.65), effect("combatPower", "neighbor-allied", "combat", 0.25, [C.terrain("mountain", "forest")])]);
add("noon-command", "日中号令", "combat", [effect("combatPower", "carried", "combat", 0.75, [C.hour(11, 14)])]);
add("deep-raid", "深入疾战", "combat", [effect("attackPower", "neighbor-hostile", "combat", 0.65, [C.armyAtLeast(1500), C.attacking(true)])]);

// Mining: cycle time and output are independent, with terrain/resource/population niches.
add("ore-sense", "辨脉识矿", "mining", [effect("miningYield", "own-tile", "mining", 1)]);
add("shift-bells", "轮班鸣钟", "mining", [effect("miningDuration", "own-tile", "mining", -1)]);
add("mountain-prospect", "山脉勘采", "mining", [effect("miningYield", "own-tile", "mining", 0.95, [C.terrain("mountain")])]);
add("river-washing", "河床淘洗", "mining", [effect("miningDuration", "own-tile", "mining", -0.9, [C.terrain("river", "coast")])]);
add("forest-charcoal", "林地炭作", "mining", [effect("miningYield", "own-tile", "mining", 0.8, [C.terrain("forest")])]);
add("rich-vein-care", "富脉精炼", "mining", [effect("miningYield", "own-tile", "mining", 0.85, [C.resourceAtLeast("A-")])]);
add("poor-vein-tools", "贫脉巧具", "mining", [effect("miningDuration", "own-tile", "mining", -0.85, [C.resourceAtMost("C")])]);
add("dense-workforce", "众工协采", "mining", [effect("miningDuration", "own-tile", "mining", -0.75, [C.populationAtLeast(6000)])]);
add("sparse-prospectors", "荒邑探砂", "mining", [effect("miningYield", "own-tile", "mining", 0.75, [C.populationAtMost(1800)])]);
add("night-shaft", "夜井灯队", "mining", [effect("miningDuration", "own-tile", "mining", -0.8, [C.hour(20, 5)])]);
add("day-assay", "日照验矿", "mining", [effect("miningYield", "own-tile", "mining", 0.75, [C.hour(8, 17)])]);
add("neighbor-tools", "邻地借械", "mining", [effect("miningDuration", "neighbor-allied", "mining", -0.7)]);
add("regional-smelter", "邻郡共炉", "mining", [effect("miningYield", "neighbor-allied", "mining", 0.7)]);
add("frontier-salvage", "边境扰采", "mining", [effect("miningYield", "enemy-neighbor", "mining", -0.6)]);
add("neutral-claim-survey", "无主矿籍", "mining", [effect("miningDuration", "neighbor-allied", "mining", -0.7, [C.neutral(true)])]);
add("carried-assayer", "随行矿师", "mining", [effect("miningYield", "carried", "mining", 0.65, [C.resourceAtLeast("B-")])]);
add("low-grade-sorting", "杂矿分选", "mining", [effect("miningYield", "own-tile", "mining", 0.65, [C.resourceAtMost("B-")]), effect("miningDuration", "own-tile", "mining", -0.25)]);
add("high-grade-caution", "精矿稳采", "mining", [effect("miningDuration", "own-tile", "mining", -0.55, [C.resourceAtLeast("S-")]), effect("miningYield", "own-tile", "mining", 0.3)]);

// Troop training: time, cost and recruit yield support different settlement shapes.
add("drillmaster", "操练严整", "training", [effect("trainingDuration", "own-tile", "training", -1)]);
add("frugal-barracks", "营务节用", "training", [effect("trainingCost", "own-tile", "training", -1)]);
add("recruiting-office", "募兵成册", "training", [effect("trainingYield", "own-tile", "training", 1)]);
add("city-muster", "大邑点兵", "training", [effect("trainingYield", "own-tile", "training", 0.9, [C.populationAtLeast(7000)])]);
add("village-militia", "乡勇简训", "training", [effect("trainingCost", "own-tile", "training", -0.85, [C.populationAtMost(2200)])]);
add("rich-armory", "富地军械", "training", [effect("trainingDuration", "own-tile", "training", -0.85, [C.resourceAtLeast("A-")])]);
add("poor-kit-reuse", "旧甲再用", "training", [effect("trainingCost", "own-tile", "training", -0.8, [C.resourceAtMost("C")])]);
add("plain-drill", "原野列阵", "training", [effect("trainingDuration", "own-tile", "training", -0.8, [C.terrain("plain")])]);
add("mountain-recruits", "山民入伍", "training", [effect("trainingYield", "own-tile", "training", 0.8, [C.terrain("mountain")])]);
add("forest-rangers", "林地乡射", "training", [effect("trainingYield", "own-tile", "training", 0.75, [C.terrain("forest")])]);
add("night-drill", "夜操轮训", "training", [effect("trainingDuration", "own-tile", "training", -0.75, [C.hour(19, 23)])]);
add("morning-rations", "晨炊定额", "training", [effect("trainingCost", "own-tile", "training", -0.7, [C.hour(5, 9)])]);
add("allied-instructors", "邻军教习", "training", [effect("trainingDuration", "neighbor-allied", "training", -0.7)]);
add("joint-recruitment", "邻邑合募", "training", [effect("trainingYield", "neighbor-allied", "training", 0.7)]);
add("border-volunteers", "边境阻募", "training", [effect("trainingYield", "enemy-neighbor", "training", -0.65)]);
add("threatened-economy", "临敌扰训", "training", [effect("trainingDuration", "enemy-neighbor", "training", 0.7)]);
add("field-instructor", "随军教头", "training", [effect("trainingDuration", "carried", "training", -0.65, [C.armyAtLeast(1000)])]);
add("balanced-barracks", "营制均衡", "training", [effect("trainingCost", "own-tile", "training", -0.5), effect("trainingYield", "own-tile", "training", 0.35, [C.populationAtLeast(4000)])]);

// Cultivation affects personal/general power training, not soldier recruitment.
add("focused-cultivation", "凝神修习", "cultivation", [effect("cultivationPower", "carried", "cultivation", 1)]);
add("simple-retreat", "简居省资", "cultivation", [effect("cultivationCost", "carried", "cultivation", -1)]);
add("mountain-retreat", "山中闭关", "cultivation", [effect("cultivationPower", "own-tile", "cultivation", 0.9, [C.terrain("mountain")])]);
add("forest-meditation", "林间澄心", "cultivation", [effect("cultivationCost", "own-tile", "cultivation", -0.85, [C.terrain("forest")])]);
add("river-breathing", "临流调息", "cultivation", [effect("cultivationPower", "own-tile", "cultivation", 0.8, [C.terrain("river", "coast")])]);
add("academy-city", "大邑讲武", "cultivation", [effect("cultivationPower", "own-tile", "cultivation", 0.85, [C.populationAtLeast(6500)])]);
add("quiet-hamlet", "小邑静修", "cultivation", [effect("cultivationCost", "own-tile", "cultivation", -0.8, [C.populationAtMost(1800)])]);
add("rich-elixirs", "丰地药资", "cultivation", [effect("cultivationPower", "own-tile", "cultivation", 0.8, [C.resourceAtLeast("A")])]);
add("scarce-discipline", "困境砺志", "cultivation", [effect("cultivationCost", "own-tile", "cultivation", -0.75, [C.resourceAtMost("C-")])]);
add("midnight-study", "子夜参悟", "cultivation", [effect("cultivationPower", "carried", "cultivation", 0.8, [C.hour(22, 3)])]);
add("dawn-practice", "晨起行功", "cultivation", [effect("cultivationCost", "carried", "cultivation", -0.7, [C.hour(5, 8)])]);
add("neighbor-lecture", "邻郡论武", "cultivation", [effect("cultivationPower", "neighbor-allied", "cultivation", 0.7)]);
add("shared-dojo", "同盟道场", "cultivation", [effect("cultivationCost", "neighbor-allied", "cultivation", -0.7)]);
add("frontier-tempering", "临境扰心", "cultivation", [effect("cultivationPower", "enemy-neighbor", "cultivation", -0.7)]);
add("measured-progress", "循序精进", "cultivation", [effect("cultivationCost", "carried", "cultivation", -0.45), effect("cultivationPower", "carried", "cultivation", 0.4, [C.hour(9, 18)])]);

// Discovery changes the existing base probability by additive percentage points.
add("keen-eye", "慧眼识才", "discovery", [effect("discoveryChance", "carried", "discovery", 0.5)]);
add("local-reputation", "乡里声望", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.48)]);
add("allied-recommendation", "邻邦荐贤", "discovery", [effect("discoveryChance", "neighbor-allied", "discovery", 0.42)]);
add("frontier-defector", "边境阻贤", "discovery", [effect("discoveryChance", "enemy-neighbor", "discovery", -0.18)]);
add("city-talent-pool", "大邑群贤", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.48, [C.populationAtLeast(7500)])]);
add("hidden-hermit", "荒邑访隐", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.44, [C.populationAtMost(1500)])]);
add("rich-patronage", "丰资礼贤", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.42, [C.resourceAtLeast("A-")])]);
add("poor-land-scout", "瘠地求士", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.4, [C.resourceAtMost("C")])]);
add("mountain-hermit", "入山访士", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.44, [C.terrain("mountain")])]);
add("forest-ranger-search", "林中寻杰", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.4, [C.terrain("forest")])]);
add("river-travellers", "津渡问贤", "discovery", [effect("discoveryChance", "own-tile", "discovery", 0.38, [C.terrain("river", "coast")])]);
add("night-visitor", "夜访名士", "discovery", [effect("discoveryChance", "carried", "discovery", 0.42, [C.hour(19, 23)])]);
add("morning-market", "早市访才", "discovery", [effect("discoveryChance", "carried", "discovery", 0.36, [C.hour(6, 10)])]);
add("neutral-pioneers", "拓荒招贤", "discovery", [effect("discoveryChance", "neighbor-allied", "discovery", 0.4, [C.neutral(true)])]);
add("wartime-recruiter", "军中拔擢", "discovery", [effect("discoveryChance", "carried", "discovery", 0.4, [C.attacking(true), C.armyAtLeast(1000)])]);

const CONDITION_OPS = new Set([
  "terrain-in", "resource-rank-gte", "resource-rank-lte", "population-gte", "population-lte",
  "neutral-is", "attacking-is", "army-size-gte", "army-size-lte", "hour-between"
]);
const SCOPES = new Set(["carried", "own-tile", "neighbor-allied", "neighbor-hostile", "enemy-neighbor"]);

function semanticSignature(definition) {
  return JSON.stringify(definition.effects.map(item => ({
    key: item.key, scope: item.scope, action: item.action, scale: item.scale,
    when: item.when.map(condition => Object.fromEntries(Object.entries(condition).sort(([a], [b]) => a.localeCompare(b))))
  })));
}

const ids = new Set();
const signatures = new Set();
for (const definition of definitions) {
  if (!/^[a-z0-9-]+$/.test(definition.id) || ids.has(definition.id)) throw new Error(`天赋 ID 重复或非法：${definition.id}`);
  ids.add(definition.id);
  const signature = semanticSignature(definition);
  if (signatures.has(signature)) throw new Error(`天赋语义重复：${definition.id}`);
  signatures.add(signature);
  for (const item of definition.effects) {
    if (!SCOPES.has(item.scope)) throw new Error(`未知天赋范围：${item.scope}`);
    for (const condition of item.when) if (!CONDITION_OPS.has(condition.op)) throw new Error(`未知天赋条件：${condition.op}`);
  }
}

const TALENT_CATALOG = deepFreeze(definitions);
const TALENT_BY_ID = Object.freeze(Object.fromEntries(TALENT_CATALOG.map(item => [item.id, item])));

function rarityForProgress(value) {
  const progress = clamp(Math.trunc(Number(value) || 0), 0, 1000);
  for (let index = RARITIES.length - 1; index >= 0; index -= 1) {
    if (progress >= RARITIES[index].progressMin) return RARITIES[index];
  }
  return RARITIES[0];
}

function potencyForProgress(value) {
  const progress = clamp(Math.trunc(Number(value) || 0), 0, 1000);
  const rarity = rarityForProgress(progress);
  const span = Math.max(1, rarity.progressMax - rarity.progressMin);
  const ratio = (progress - rarity.progressMin) / span;
  return round6(rarity.potencyMin + ratio * (rarity.potencyMax - rarity.potencyMin));
}

function progressForPotency(value) {
  const potency = clamp(Number(value) || 0, RARITIES[0].potencyMin, RARITIES.at(-1).potencyMax);
  const rarity = RARITIES.find(item => potency <= item.potencyMax) || RARITIES.at(-1);
  const ratio = clamp((potency - rarity.potencyMin) / Math.max(1e-9, rarity.potencyMax - rarity.potencyMin), 0, 1);
  return Math.round(rarity.progressMin + ratio * (rarity.progressMax - rarity.progressMin));
}

function pickRarity(seed, id) {
  const total = RARITIES.reduce((sum, rarity) => sum + rarity.weight, 0);
  let ticket = hashUnit(seed, "rarity", id) * total;
  for (const rarity of RARITIES) {
    ticket -= rarity.weight;
    if (ticket < 0) return rarity;
  }
  return RARITIES[0];
}

function pickCatalogId(seed, id, excludedId = null) {
  const choices = excludedId ? TALENT_CATALOG.filter(item => item.id !== excludedId) : TALENT_CATALOG;
  return choices[Math.floor(hashUnit(seed, "talent", id, excludedId || "") * choices.length) % choices.length].id;
}

function normalizedOptions(seedOrOptions, idValue) {
  if (seedOrOptions && typeof seedOrOptions === "object" && !Array.isArray(seedOrOptions)) {
    return { ...seedOrOptions, seed: String(seedOrOptions.seed ?? "talent"), id: String(seedOrOptions.id ?? seedOrOptions.instanceId ?? "talent") };
  }
  return { seed: String(seedOrOptions ?? "talent"), id: String(idValue ?? "talent") };
}

function rollTalent(seedOrOptions, idValue) {
  const options = normalizedOptions(seedOrOptions, idValue);
  const talentId = TALENT_BY_ID[options.talentId] ? options.talentId : pickCatalogId(options.seed, options.id);
  const requestedRarity = RARITY_BY_ID[options.rarity];
  const rarity = requestedRarity || pickRarity(options.seed, options.id);
  const width = rarity.progressMax - rarity.progressMin + 1;
  const progress = rarity.progressMin + (hash(options.seed, "quality", options.id, talentId).readUInt32BE(0) % width);
  return deepFreeze({
    schema: TALENT_SCHEMA,
    instanceId: String(options.id),
    talentId,
    rarity: rarity.id,
    progress,
    potency: potencyForProgress(progress),
    potencyPercent: round2(potencyForProgress(progress) * 100),
    version: 1
  });
}

function normalizeTalent(talent, seedOrId = "talent", idValue) {
  if (!talent || typeof talent !== "object") return rollTalent(seedOrId, idValue);
  const seed = typeof seedOrId === "object" ? String(seedOrId.seed ?? "talent") : String(seedOrId ?? "talent");
  const fallbackId = typeof seedOrId === "object" ? seedOrId.id : idValue;
  const instanceId = String(talent.instanceId ?? fallbackId ?? talent.id ?? "talent");
  const talentId = TALENT_BY_ID[talent.talentId]
    ? talent.talentId
    : (TALENT_BY_ID[talent.id] ? talent.id : pickCatalogId(seed, instanceId));
  let progress;
  if (Number.isFinite(Number(talent.progress))) {
    progress = clamp(Math.trunc(Number(talent.progress)), 0, 1000);
  } else if (Number.isFinite(Number(talent.potency))) {
    progress = progressForPotency(talent.potency);
  } else {
    const rarity = RARITY_BY_ID[talent.rarity] || pickRarity(seed, instanceId);
    const width = rarity.progressMax - rarity.progressMin + 1;
    progress = rarity.progressMin + (hash(seed, "normalize", instanceId, talentId).readUInt32BE(0) % width);
  }
  const rarity = rarityForProgress(progress);
  const potency = potencyForProgress(progress);
  return deepFreeze({ schema: TALENT_SCHEMA, instanceId, talentId, rarity: rarity.id, progress, potency, potencyPercent: round2(potency * 100), version: 1 });
}

const KEY_LABELS = Object.freeze({
  marchDuration: "行军时长", marchCost: "行军消耗", combatPower: "战斗力", attackPower: "进攻力", defensePower: "防御力",
  miningDuration: "采集时长", miningYield: "采集产量", trainingDuration: "练兵时长", trainingCost: "练兵消耗",
  trainingYield: "练兵产量", cultivationCost: "修炼消耗", cultivationPower: "修炼收益", discoveryChance: "发现概率"
});
const SCOPE_LABELS = Object.freeze({ carried: "携带时", "own-tile": "部署地", "neighbor-allied": "相邻友方地", "neighbor-hostile": "相邻敌方地", "enemy-neighbor": "削弱敌方相邻8格：" });

function formatPercent(value) {
  return `${(Math.abs(Number(value)) * 100).toFixed(2)}%`;
}

function describeTalent(talent) {
  const normalized = normalizeTalent(talent, talent?.instanceId || "describe");
  const definition = TALENT_BY_ID[normalized.talentId];
  const rarity = RARITY_BY_ID[normalized.rarity];
  const clauses = definition.effects.map(item => {
    const amount = normalized.potency * Math.abs(item.scale);
    const direction = item.scale < 0 ? "降低" : "提高";
    return `${SCOPE_LABELS[item.scope]}${KEY_LABELS[item.key]}${direction}${formatPercent(amount)}`;
  });
  return `【${rarity.label}】${definition.name}：${clauses.join("；")}。`;
}

function resourceRank(value) {
  if (Number.isFinite(Number(value))) return clamp(Math.trunc(Number(value)), 0, RESOURCE_GRADES.length - 1);
  const found = RESOURCE_GRADES.indexOf(String(value || ""));
  return found < 0 ? 0 : found;
}

function cellAt(state, position) {
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null;
  return state?.cells?.[`${Math.trunc(Number(position.x))},${Math.trunc(Number(position.y))}`] || null;
}

function actionName(value) {
  const action = String(value || "");
  if (action === "train") return "training";
  if (action === "power-train") return "cultivation";
  if (action === "mine") return "mining";
  return action;
}

function evaluationFacts(state, context) {
  const action = actionName(context.action);
  const position = context.tile || context.position || context.target || context.origin || null;
  const cell = context.cell || cellAt(state, position) || {};
  const actorAccountId = String(context.actorAccountId ?? context.holderAccountId ?? "");
  const owner = context.ownerAccountId ?? cell.ownerAccountId ?? null;
  let relation = context.relation;
  if (!relation) relation = owner == null ? "neutral" : (String(owner) === actorAccountId ? "allied" : "hostile");
  const now = Number(context.now);
  const hour = Number.isFinite(Number(context.hour))
    ? ((Math.trunc(Number(context.hour)) % 24) + 24) % 24
    : (Number.isFinite(now) ? new Date(now).getUTCHours() : 12);
  return {
    action, position, cell, actorAccountId, relation,
    terrain: String(context.terrain ?? cell.terrain ?? "plain"),
    resourceRank: resourceRank(context.resourceRank ?? context.resourceGrade ?? cell.resourceRank ?? cell.resourceGrade),
    population: Math.max(0, Number(context.population ?? cell.population ?? 0) || 0),
    neutral: context.neutral == null ? relation === "neutral" : Boolean(context.neutral),
    attacking: Boolean(context.attacking ?? context.attack),
    armySize: Math.max(0, Number(context.armySize ?? context.soldiers ?? 0) || 0),
    hour
  };
}

function conditionMatches(condition, facts) {
  switch (condition.op) {
    case "terrain-in": return condition.values.includes(facts.terrain);
    case "resource-rank-gte": return facts.resourceRank >= resourceRank(condition.value);
    case "resource-rank-lte": return facts.resourceRank <= resourceRank(condition.value);
    case "population-gte": return facts.population >= condition.value;
    case "population-lte": return facts.population <= condition.value;
    case "neutral-is": return facts.neutral === condition.value;
    case "attacking-is": return facts.attacking === condition.value;
    case "army-size-gte": return facts.armySize >= condition.value;
    case "army-size-lte": return facts.armySize <= condition.value;
    case "hour-between": {
      const start = ((condition.start % 24) + 24) % 24;
      const end = ((condition.end % 24) + 24) % 24;
      return start <= end ? facts.hour >= start && facts.hour <= end : facts.hour >= start || facts.hour <= end;
    }
    default: return false;
  }
}

function samePosition(left, right) {
  return left && right && Number(left.x) === Number(right.x) && Number(left.y) === Number(right.y);
}

function neighboring(left, right) {
  if (!left || !right) return false;
  const dx = Math.abs(Number(left.x) - Number(right.x));
  const dy = Math.abs(Number(left.y) - Number(right.y));
  return Math.max(dx, dy) === 1;
}

function scopeMatches(scope, source, facts) {
  const owned = !facts.actorAccountId || !source.holderAccountId || source.holderAccountId === facts.actorAccountId;
  if (scope === "carried") return owned && (source.status === "carried" || source.status === "captured");
  if (source.status !== "deployed") return false;
  if (scope === "own-tile") return owned && samePosition(source.location, facts.position) && facts.relation === "allied";
  if (scope === "neighbor-allied") return owned && neighboring(source.location, facts.position) && facts.relation === "allied";
  if (scope === "neighbor-hostile") return owned && neighboring(source.location, facts.position) && (facts.relation === "hostile" || facts.relation === "neutral");
  if (scope === "enemy-neighbor") return !owned && neighboring(source.location, facts.position);
  return false;
}

function sourceFrom(value, fallback = {}) {
  const wrapper = value?.talent ? value : { talent: value };
  return {
    talent: wrapper.talent,
    generalId: String(wrapper.generalId ?? fallback.generalId ?? ""),
    holderAccountId: String(wrapper.holderAccountId ?? fallback.holderAccountId ?? ""),
    status: String(wrapper.status ?? fallback.status ?? "carried"),
    location: wrapper.location ?? fallback.location ?? null
  };
}

function collectSources(state, context, actorAccountId) {
  let sources = [];
  if (Array.isArray(context.talents)) {
    sources = context.talents.map(value => sourceFrom(value));
  } else if (context.talent) {
    sources = [sourceFrom(context.talent, context)];
  } else {
    sources = Object.entries(state?.generals || {}).filter(([, general]) => general?.talent).map(([generalId, general]) => sourceFrom(general.talent, {
      generalId,
      holderAccountId: general.holderAccountId,
      status: general.status,
      location: general.location
    }));
  }
  const seen = new Set();
  return sources.filter(source => {
    const key = source.generalId || String(source.talent?.instanceId || source.talent?.id || "");
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return Boolean(source.talent);
  }).slice(0, 16);
}

function talentModifiers(state = {}, context = {}) {
  const facts = evaluationFacts(state, context || {});
  const totals = Object.fromEntries(MODIFIER_KEYS.map(key => [key, 0]));
  const applied = [];
  const sources = collectSources(state, context || {}, facts.actorAccountId);
  for (const source of sources) {
    const talent = normalizeTalent(source.talent, state?.seed || "state", source.generalId || source.talent?.instanceId);
    const definition = TALENT_BY_ID[talent.talentId];
    for (let index = 0; index < definition.effects.length; index += 1) {
      const item = definition.effects[index];
      if (item.action !== facts.action || !scopeMatches(item.scope, source, facts)) continue;
      if (!item.when.every(condition => conditionMatches(condition, facts))) continue;
      const value = round6(talent.potency * item.scale);
      totals[item.key] += value;
      applied.push(Object.freeze({ generalId: source.generalId || null, talentId: talent.talentId, effectIndex: index, scope: item.scope, key: item.key, value, enemyDebuff: item.scope === "enemy-neighbor" }));
    }
  }
  for (const key of MODIFIER_KEYS) totals[key] = round6(clamp(totals[key], MODIFIER_LIMITS[key][0], MODIFIER_LIMITS[key][1]));
  return deepFreeze({ ...totals, applied, evaluatedTalents: sources.length });
}

function upgradeTalent(talent, materialValue, params = {}) {
  if (typeof params === "string" || typeof params === "number") params = { seed: String(params) };
  if (!params || typeof params !== "object") params = {};
  const current = normalizeTalent(talent, params.seed || "upgrade", params.id);
  const materialId = typeof materialValue === "string" ? materialValue : materialValue?.id;
  const material = MATERIAL_BY_ID[materialId];
  if (!material) throw new Error(`未知天赋素材：${String(materialId || "")}`);
  let next;
  let randomFactor = null;
  let rolledProgressDelta = null;
  if (material.mode === "reroll") {
    const seed = String(params.seed ?? current.instanceId);
    const nonce = String(params.nonce ?? 0);
    const talentId = pickCatalogId(seed, `${current.instanceId}:reroll:${nonce}`, current.talentId);
    next = rollTalent({ seed, id: current.instanceId, talentId });
  } else {
    let progress = current.progress;
    if (material.mode === "ascend") {
      const red = RARITY_BY_ID.red;
      const width = red.progressMax - red.progressMin + 1;
      progress = Math.max(progress, red.progressMin + (hash(params.seed ?? current.instanceId, "ascend", params.nonce ?? 0).readUInt32BE(0) % width));
    } else {
      const seed = String(params.seed ?? current.instanceId);
      const nonce = String(params.nonce ?? 0);
      randomFactor = 0.9 + hashUnit(seed, "material-growth", current.instanceId, nonce, material.id) * 0.2;
      rolledProgressDelta = Math.max(1, Math.round(material.progress * randomFactor));
      progress = clamp(progress + rolledProgressDelta, 0, 1000);
    }
    next = normalizeTalent({ ...current, progress }, params.seed || current.instanceId, current.instanceId);
  }
  return deepFreeze({
    talent: next,
    consumed: material.id,
    changed: JSON.stringify(current) !== JSON.stringify(next),
    progressDelta: next.progress - current.progress,
    rolledProgressDelta,
    randomFactor: randomFactor == null ? null : round6(randomFactor),
    previous: current
  });
}

module.exports = {
  TALENT_SCHEMA,
  RARITIES,
  RARITY_BY_ID,
  MATERIALS,
  MATERIAL_BY_ID,
  MODIFIER_KEYS,
  MODIFIER_LIMITS,
  TALENT_CATALOG,
  TALENT_BY_ID,
  catalog: TALENT_CATALOG,
  rarities: RARITIES,
  materials: MATERIALS,
  rollTalent,
  normalizeTalent,
  describeTalent,
  talentModifiers,
  upgradeTalent
};
