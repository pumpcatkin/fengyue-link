const crypto = require("node:crypto");
const {
  MATERIALS: TALENT_MATERIALS,
  MATERIAL_BY_ID,
  TALENT_BY_ID,
  rollTalent,
  normalizeTalent,
  describeTalent,
  talentModifiers,
  upgradeTalent
} = require("./grid-talents.cjs");

const GRID_GAME_ID = "cc.aiero.fyow.grid-conquest";
const GRID_SIZE = 64;
const RESOURCE_GRADES = Object.freeze(["D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S-", "S", "S+"]);
// The centre of the map is deliberately richer than the frontier.  Keep the
// layer boundaries and multipliers in one immutable table so every client can
// derive exactly the same facts from the season seed.
const CENTRAL_LAYER_MULTIPLIERS = Object.freeze([1, 1.2, 1.5, 2]);
const CENTRAL_LAYER_BOUNDARIES = Object.freeze([0.25, 0.5, 0.75]);
const CENTRAL_NEUTRAL_RADIUS = 2;
const SPAWN_NEUTRAL_RADIUS = 2; // a radius of two is a 5x5 neighbourhood
const SPAWN_EDGE_BAND = Math.floor(GRID_SIZE / 4);
const TERRAIN_TYPES = Object.freeze(["plain", "forest", "mountain", "river", "coast"]);
const ORIENTATIONS = new Set(["men", "women", "any"]);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DIALOGUE_COOLDOWN_MS = 15 * 1000;
const MARKET_RELIST_COOLDOWN_MS = 6 * HOUR;
const TRAINING_COST_GROWTH = 1.15;
const TRAINING_BATCH_MAX = 10;
const MAX_TRAINING_LEVEL = 100;
const ACTIVE_CARRIED_GENERAL_LIMIT = 2;
const DEFAULT_PLAYER_BASE_POWER = 500;
const STARTING_PLAYER_GOLD = 500;
const MAX_GENERAL_CORE_SETTING_LENGTH = 12000;
const RESOURCE_YIELD_FORMULA_VERSION = 5;
const MINING_DURATION_MS = 10 * MINUTE;
const MAX_CONCURRENT_MINING_JOBS = 3;
const MINING_COOLDOWN_MIN_MS = HOUR;
const MINING_COOLDOWN_MAX_MS = 4 * HOUR;
const MARCH_MS_PER_CELL = 15 * 1000;
const MINING_GRADE_YIELD_MULTIPLIERS = Object.freeze(
  RESOURCE_GRADES.map((_, index) => 2.8 + index * 0.18)
);
const GENERAL_EXPERIENCE_REQUIREMENTS = Object.freeze([100, 300, 800, 1800, 3600]);
const GENERAL_TRAINING_EXPERIENCE_MINUTES = Object.freeze([30, 90, 180, 360, 720]);
const GENERAL_IDLE_EXPERIENCE_MINUTES = Object.freeze([180, 540, 1080, 2160, 4320]);
const GENERAL_DEFENSE_CULTIVATION_BONUSES = Object.freeze([0.05, 0.1, 0.2, 0.4, 0.6, 0.9]);
const PLAYER_CULTIVATION_GOLD_MULTIPLIER = 2.5;
const PLAYER_CULTIVATION_POWER_MULTIPLIER = 0.9;
const GENERAL_BATTLE_EXPERIENCE_MAX_RATE = 0.48;
const GENERAL_BATTLE_EXPERIENCE_MIN_RATE = 0.1;
const CULTIVATION_RANGES = Object.freeze([
  Object.freeze({ attempt: 1, gateHours: 0, goldMin: 5000, goldMax: 8000, powerGainMin: 0.065, powerGainMax: 0.11 }),
  Object.freeze({ attempt: 2, gateHours: 0, goldMin: 12000, goldMax: 18000, powerGainMin: 0.10, powerGainMax: 0.155 }),
  Object.freeze({ attempt: 3, gateHours: 0, goldMin: 30000, goldMax: 45000, powerGainMin: 0.145, powerGainMax: 0.22 }),
  Object.freeze({ attempt: 4, gateHours: 0, goldMin: 70000, goldMax: 100000, powerGainMin: 0.20, powerGainMax: 0.31 }),
  Object.freeze({ attempt: 5, gateHours: 0, goldMin: 160000, goldMax: 240000, powerGainMin: 0.28, powerGainMax: 0.44 })
]);
const MATERIAL_IDS = Object.freeze(TALENT_MATERIALS.map(item => item.id));
const CULTIVATION_MATERIAL_IDS = MATERIAL_IDS;

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${name}必须是 ${minimum} 到 ${maximum} 的整数`);
  return number;
}

function coordinate(value, name) {
  return integer(value, name, 0, GRID_SIZE - 1);
}

function keyOf(x, y) { return `${x},${y}`; }

function entropy(seed, ...parts) {
  return crypto.createHash("sha256").update([seed, ...parts].join("\0")).digest();
}

function randomUnit(seed, ...parts) {
  return entropy(seed, ...parts).readUInt32BE(0) / 0x100000000;
}

function centralLayer(xValue, yValue) {
  const x = coordinate(xValue, "横坐标");
  const y = coordinate(yValue, "纵坐标");
  const normalizedDistance = normalizedCenterDistances(x, y).chebyshev;
  if (normalizedDistance < CENTRAL_LAYER_BOUNDARIES[0]) return 4;
  if (normalizedDistance < CENTRAL_LAYER_BOUNDARIES[1]) return 3;
  if (normalizedDistance < CENTRAL_LAYER_BOUNDARIES[2]) return 2;
  return 1;
}

function normalizedCenterDistances(xValue, yValue) {
  const x = coordinate(xValue, "横坐标");
  const y = coordinate(yValue, "纵坐标");
  const centre = (GRID_SIZE - 1) / 2;
  return Object.freeze({
    manhattan: (Math.abs(x - centre) + Math.abs(y - centre)) / (GRID_SIZE - 1),
    chebyshev: Math.max(Math.abs(x - centre), Math.abs(y - centre)) / centre
  });
}

function centralLayerMultiplier(layer) {
  const normalized = clamp(Math.trunc(Number(layer) || 1), 1, CENTRAL_LAYER_MULTIPLIERS.length);
  return CENTRAL_LAYER_MULTIPLIERS[normalized - 1];
}

function isCentralNeutralCell(xValue, yValue) {
  const x = coordinate(xValue, "横坐标");
  const y = coordinate(yValue, "纵坐标");
  const centreX = Math.floor((GRID_SIZE - 1) / 2);
  const centreY = Math.floor((GRID_SIZE - 1) / 2);
  return Math.abs(x - centreX) <= CENTRAL_NEUTRAL_RADIUS && Math.abs(y - centreY) <= CENTRAL_NEUTRAL_RADIUS;
}

function centralLayerColor(layerValue) {
  const layer = clamp(Math.trunc(Number(layerValue) || 1), 1, 4);
  return ["frontier", "lowlands", "heartland", "core"][layer - 1];
}

function staticCell(seed, xValue, yValue) {
  const x = coordinate(xValue, "横坐标");
  const y = coordinate(yValue, "纵坐标");
  const bytes = entropy(String(seed), "cell", x, y);
  const centralLayerValue = centralLayer(x, y);
  const centerDistances = normalizedCenterDistances(x, y);
  const layerMultiplier = centralLayerMultiplier(centralLayerValue);
  // The frontier keeps the original 100..10,000 seeded population roll. Inner
  // layers apply their multiplier to that same immutable base roll.
  const populationBase = 100 + (bytes.readUInt32BE(0) % 9901);
  const population = Math.round(populationBase * layerMultiplier);
  const roll = bytes.readUInt16BE(4) / 0x10000;
  const rank = clamp(Math.floor(Math.pow(roll, 1.7) * RESOURCE_GRADES.length), 0, RESOURCE_GRADES.length - 1);
  const terrain = TERRAIN_TYPES[bytes.readUInt8(6) % TERRAIN_TYPES.length];
  return {
    x, y, population, populationBase, terrain,
    centralLayer: centralLayerValue,
    layer: centralLayerValue,
    layerColor: centralLayerColor(centralLayerValue),
    centralNeutral: isCentralNeutralCell(x, y),
    isCentralNeutral: isCentralNeutralCell(x, y),
    normalizedManhattanDistance: centerDistances.manhattan,
    normalizedChebyshevDistance: centerDistances.chebyshev,
    layerMultiplier,
    layerRatio: layerMultiplier,
    populationMultiplier: layerMultiplier,
    resourceMultiplier: layerMultiplier,
    resourceGrade: RESOURCE_GRADES[rank],
    resourceRank: rank,
    garrisonCap: Math.floor(population * 0.2),
    neutralPower: Math.floor(population * 0.2)
  };
}

function dynamicCell(state, x, y) {
  const key = keyOf(x, y);
  return state.cells[key] || (state.cells[key] = { ownerAccountId: null, soldiers: 0, generalIds: [] });
}

function createWorld({ seed = crypto.randomBytes(16).toString("hex"), seasonId = crypto.randomUUID(), startedAt = Date.now(), authorityAccountId = null } = {}) {
  return {
    schema: "fyow.grid-state/1",
    gameId: GRID_GAME_ID,
    seasonId: String(seasonId),
    seed: String(seed),
    width: GRID_SIZE,
    height: GRID_SIZE,
    startedAt: Number(startedAt),
    authorityAccountId: authorityAccountId ? String(authorityAccountId) : null,
    revision: 0,
    cells: {},
    players: {},
    bans: {},
    playerEpochs: {},
    privatePlayers: {},
    generals: {},
    marketListings: {},
    marketSales: {},
    jobs: {},
    treasureSpawns: {},
    claimedTreasures: {},
    treasureEpoch: 0,
    processedIntents: []
  };
}

function resetPlayerState(inputState, targetAccountId, nextEpoch) {
  const state = inputState;
  const target = String(targetAccountId || "").trim();
  if (!target) throw new Error("缺少需要重置的玩家账号");
  state.bans ||= {};
  state.playerEpochs ||= {};
  state.players ||= {};
  state.privatePlayers ||= {};
  state.generals ||= {};
  state.marketListings ||= {};
  state.marketSales ||= {};
  state.jobs ||= {};
  const deployedIds = new Set(Object.entries(state.generals)
    .filter(([, general]) => String(general?.holderAccountId || "") === target)
    .map(([id]) => id));
  for (const [key, cell] of Object.entries(state.cells || {})) {
    if (String(cell?.ownerAccountId || "") === target) delete state.cells[key];
    else if (Array.isArray(cell?.generalIds)) cell.generalIds = cell.generalIds.filter(id => !deployedIds.has(String(id)));
  }
  for (const [id, general] of Object.entries(state.generals)) {
    if (String(general?.holderAccountId || "") === target) delete state.generals[id];
  }
  for (const [id, job] of Object.entries(state.jobs)) {
    if (String(job?.accountId || "") === target) delete state.jobs[id];
  }
  for (const [id, listing] of Object.entries(state.marketListings)) {
    if (String(listing?.sellerAccountId || "") === target) delete state.marketListings[id];
  }
  for (const [id, sale] of Object.entries(state.marketSales)) {
    if (String(sale?.sellerAccountId || "") === target || String(sale?.buyerAccountId || "") === target) delete state.marketSales[id];
  }
  delete state.players[target];
  delete state.privatePlayers[target];
  const currentEpoch = Math.max(0, Math.trunc(Number(state.playerEpochs[target] || 0)));
  state.playerEpochs[target] = Number.isSafeInteger(Number(nextEpoch)) && Number(nextEpoch) > currentEpoch
    ? Number(nextEpoch)
    : currentEpoch + 1;
  return state;
}

function chooseCapital(state, accountId) {
  const start = entropy(state.seed, "capital", accountId).readUInt16BE(0) % (GRID_SIZE * GRID_SIZE);
  const candidates = [];
  for (let offset = 0; offset < GRID_SIZE * GRID_SIZE; offset += 1) {
    const index = (start + offset * 97) % (GRID_SIZE * GRID_SIZE);
    const x = index % GRID_SIZE;
    const y = Math.floor(index / GRID_SIZE);
    if (!state.cells?.[keyOf(x, y)]?.ownerAccountId) candidates.push({ x, y });
  }
  const isUnowned = (x, y) => !state.cells?.[keyOf(x, y)]?.ownerAccountId;
  const hasUnownedFiveByFive = ({ x, y }) => {
    if (x < SPAWN_NEUTRAL_RADIUS || y < SPAWN_NEUTRAL_RADIUS
      || x >= GRID_SIZE - SPAWN_NEUTRAL_RADIUS || y >= GRID_SIZE - SPAWN_NEUTRAL_RADIUS) return false;
    for (let dy = -SPAWN_NEUTRAL_RADIUS; dy <= SPAWN_NEUTRAL_RADIUS; dy += 1) {
      for (let dx = -SPAWN_NEUTRAL_RADIUS; dx <= SPAWN_NEUTRAL_RADIUS; dx += 1) {
        if (!isUnowned(x + dx, y + dy)) return false;
      }
    }
    return true;
  };
  // Search broad map layers from the frontier inward. The account-seeded
  // candidate order spreads capitals throughout each layer instead of filling
  // the closest border ring first.
  for (let layer = 1; layer <= CENTRAL_LAYER_MULTIPLIERS.length; layer += 1) {
    const location = candidates.find(candidate => centralLayer(candidate.x, candidate.y) === layer && hasUnownedFiveByFive(candidate));
    if (location) return location;
  }
  // Never place a new capital into a partially occupied neighbourhood: the
  // five-by-five neutral buffer is part of the join contract.
  throw new Error("地图已经没有完整的五乘五出生区");
}

function allowedGeneralGender(orientation, seed, ...parts) {
  if (orientation === "men") return "male";
  if (orientation === "women") return "female";
  return randomUnit(seed, "general-gender", ...parts) < 0.5 ? "male" : "female";
}

function normalizedCharacterTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = value.map(item => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const tag = String(item.tag ?? item.name ?? item.label ?? "").trim();
      const note = String(item.note ?? item.annotation ?? "").trim();
      return tag ? (note ? `${tag}｜${note}` : tag) : "";
    }
    return String(item || "").trim();
  }).filter(Boolean);
  return [...new Set(tags)].slice(0, 80);
}

function selectGeneralDirectionTags(privatePlayer, seed, ...parts) {
  const tags = normalizedCharacterTags(privatePlayer?.characterTags);
  if (!tags.length) return [];
  const count = Math.min(tags.length, 1 + Math.floor(randomUnit(seed, "general-tag-count", ...parts) * 3));
  return tags
    .map(tag => ({ tag, score: entropy(seed, "general-tag", ...parts, tag).toString("hex") }))
    .sort((left, right) => left.score.localeCompare(right.score))
    .slice(0, count)
    .map(item => item.tag);
}

function generalDiscoveryChance(population) {
  return 0.019 + ((clamp(Number(population), 100, 10000) - 100) / 9900) * 0.221;
}

// Training discovery is intentionally much rarer than discovering a local
// notable after a battle. The roll is capped at the first 1,000 trained
// soldiers and produces at most one candidate for a completed training job.
const TRAINING_GENERAL_DISCOVERY_PER_SOLDIER = 0.000095;

function trainingGeneralDiscoveryChance(soldiers) {
  const count = clamp(Math.trunc(Number(soldiers) || 0), 0, 1000);
  return 1 - Math.pow(1 - TRAINING_GENERAL_DISCOVERY_PER_SOLDIER, count);
}

function normalizeTrainingDiscoveryWindow(privatePlayer) {
  if (!privatePlayer || typeof privatePlayer !== "object") return { trained: 0, discovered: false };
  const source = privatePlayer.trainingDiscoveryWindow;
  const trained = Number.isSafeInteger(Number(source?.trained))
    ? clamp(Number(source.trained), 0, 999)
    : 0;
  privatePlayer.trainingDiscoveryWindow = {
    trained,
    discovered: Boolean(source?.discovered)
  };
  return privatePlayer.trainingDiscoveryWindow;
}

function maxTrainingInputForRemaining(remainingValue, yieldModifier = 0) {
  const remaining = Math.max(0, Math.trunc(Number(remainingValue) || 0));
  if (!remaining) return 0;
  let low = 0;
  let high = Math.min(10000, remaining);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const output = roundByModifier(middle, yieldModifier, 1);
    if (output <= remaining) low = middle;
    else high = middle - 1;
  }
  return low;
}

function resourceCycleMs() {
  return MINING_DURATION_MS;
}

function miningCooldownMs(cell) {
  const rank = clamp(Math.trunc(Number(cell?.resourceRank) || 0), 0, RESOURCE_GRADES.length - 1);
  const ratio = rank / Math.max(1, RESOURCE_GRADES.length - 1);
  return Math.round(MINING_COOLDOWN_MIN_MS + ratio * (MINING_COOLDOWN_MAX_MS - MINING_COOLDOWN_MIN_MS));
}

function miningCooldownsFor(state, accountId) {
  const privatePlayer = state.privatePlayers[String(accountId)] ||= { orientation: "any" };
  privatePlayer.miningCooldowns ||= {};
  return privatePlayer.miningCooldowns;
}

function resourceYield(cell) {
  const population = clamp(Number(cell?.population) || 100, 100, 20000);
  const resourceMultiplier = Math.max(1, Number(cell?.resourceMultiplier || cell?.layerMultiplier || 1));
  const hasPopulationBase = Number.isFinite(Number(cell?.populationBase)) && Number(cell.populationBase) > 0;
  const basePopulation = hasPopulationBase
    ? clamp(Number(cell.populationBase), 100, 10000)
    : population / resourceMultiplier;
  const resourceRank = clamp(Math.trunc(Number(cell?.resourceRank) || 0), 0, RESOURCE_GRADES.length - 1);
  const gradeMultiplier = MINING_GRADE_YIELD_MULTIPLIERS[resourceRank];
  const hourlyGold = (400 + basePopulation * 0.09) * resourceMultiplier * (1 + resourceRank * 0.08) * gradeMultiplier;
  return Math.max(1, Math.round(hourlyGold * resourceCycleMs({ ...cell, population, resourceRank }) / HOUR));
}

function trainDurationMs(amount) {
  return clamp(MINUTE + Math.ceil(Number(amount) / 5) * 1000, MINUTE, HOUR);
}

function trainingPower(basePowerValue, levelValue) {
  const basePower = clamp(Math.trunc(Number(basePowerValue) || DEFAULT_PLAYER_BASE_POWER), 1, 100000);
  const level = clamp(Math.trunc(Number(levelValue) || 0), 0, MAX_TRAINING_LEVEL);
  const milestoneMultiplier = Math.pow(1.25, Math.floor(level / 10));
  return Math.min(100000000, Math.floor(basePower * (1 + level * 0.06) * milestoneMultiplier));
}

function ensurePowerProgress(target, fallbackBasePower = DEFAULT_PLAYER_BASE_POWER) {
  if (!target || typeof target !== "object") return target;
  const legacyPower = Number(target.power);
  const basePower = Number.isSafeInteger(Number(target.basePower)) && Number(target.basePower) > 0
    ? Number(target.basePower)
    : (Number.isSafeInteger(legacyPower) && legacyPower > 0 ? legacyPower : fallbackBasePower);
  const trainingLevel = clamp(Math.trunc(Number(target.trainingLevel) || 0), 0, MAX_TRAINING_LEVEL);
  target.basePower = clamp(basePower, 1, 100000);
  target.trainingLevel = trainingLevel;
  target.power = trainingPower(target.basePower, trainingLevel);
  return target;
}

function generalExperienceRequirement(generalOrCount) {
  const count = typeof generalOrCount === "object"
    ? clamp(Math.trunc(Number(generalOrCount?.cultivationCount) || 0), 0, CULTIVATION_RANGES.length)
    : clamp(Math.trunc(Number(generalOrCount) || 0), 0, CULTIVATION_RANGES.length);
  return count >= CULTIVATION_RANGES.length ? 0 : GENERAL_EXPERIENCE_REQUIREMENTS[count];
}

function ensureGeneralExperience(general) {
  if (!general || typeof general !== "object") return general;
  const required = generalExperienceRequirement(general);
  const experience = Math.max(0, Number(general.experience) || 0);
  general.experience = required ? Math.min(required, Math.round(experience * 1000) / 1000) : 0;
  const updatedAt = Number(general.experienceUpdatedAt || 0);
  general.experienceUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
  return general;
}

function grantGeneralExperience(general, amountValue) {
  ensureGeneralExperience(general);
  const required = generalExperienceRequirement(general);
  if (!required) return 0;
  const before = general.experience;
  const amount = Math.max(0, Number(amountValue) || 0);
  general.experience = Math.min(required, Math.round((before + amount) * 1000) / 1000);
  return Math.max(0, Math.round((general.experience - before) * 1000) / 1000);
}

function generalDefenseCultivationRate(generalOrCount) {
  const count = typeof generalOrCount === "object"
    ? clamp(Math.trunc(Number(generalOrCount?.cultivationCount) || 0), 0, CULTIVATION_RANGES.length)
    : clamp(Math.trunc(Number(generalOrCount) || 0), 0, CULTIVATION_RANGES.length);
  return GENERAL_DEFENSE_CULTIVATION_BONUSES[count];
}

function generalDefenseBonusPower(general) {
  return Math.max(0, Math.round(generalPower(general) * generalDefenseCultivationRate(general)));
}

function deployedGeneralIdsAt(state, accountId, x, y) {
  const cell = state.cells?.[keyOf(x, y)];
  if (!cell || String(cell.ownerAccountId || "") !== String(accountId || "")) return [];
  return (cell.generalIds || []).filter(id => {
    const general = state.generals?.[id];
    return general?.status === "deployed"
      && String(general.holderAccountId || "") === String(accountId || "")
      && Number(general.location?.x) === Number(x)
      && Number(general.location?.y) === Number(y);
  });
}

function generalBattleExperienceGain(general, powerDifferenceValue) {
  const required = generalExperienceRequirement(general);
  if (!required) return 0;
  const difference = Math.max(0, Number(powerDifferenceValue) || 0);
  const rate = Math.max(
    GENERAL_BATTLE_EXPERIENCE_MIN_RATE,
    GENERAL_BATTLE_EXPERIENCE_MAX_RATE / (1 + difference / 250)
  );
  return Math.max(0.001, Math.round(required * rate * 1000) / 1000);
}

function generalMarchExperienceGain(general, distanceValue) {
  const required = generalExperienceRequirement(general);
  const distance = Math.max(0, Math.trunc(Number(distanceValue) || 0));
  return required && distance ? Math.max(0.001, Math.round(required * distance / 12000 * 1000) / 1000) : 0;
}

function accrueDeployedGeneralExperience(state, nowValue, experienceSinceValue, effects = [], activeAccountId = null) {
  const now = Number(nowValue);
  const experienceSince = Math.max(0, Number(experienceSinceValue) || 0);
  for (const [generalId, general] of Object.entries(state.generals || {})) {
    if (general?.status !== "deployed" || !general.location) continue;
    if (activeAccountId && String(general.holderAccountId || "") !== String(activeAccountId)) continue;
    ensureGeneralExperience(general);
    const required = generalExperienceRequirement(general);
    const previousCursor = Number(general.experienceUpdatedAt || 0);
    let cursor = Math.max(previousCursor || experienceSince || now, experienceSince);
    if (!Number.isFinite(cursor) || cursor <= 0 || cursor > now) cursor = now;
    const minutes = Math.floor((now - cursor) / MINUTE);
    if (!minutes) {
      if (!previousCursor) general.experienceUpdatedAt = cursor;
      continue;
    }
    let amount = 0;
    for (let index = 1; index <= minutes; index += 1) {
      const minuteAt = cursor + index * MINUTE;
      const training = Object.values(state.jobs || {}).some(job => job?.type === "training"
        && String(job.accountId || "") === String(general.holderAccountId || "")
        && Number(job.x) === Number(general.location.x)
        && Number(job.y) === Number(general.location.y)
        && Number(job.startedAt || 0) < minuteAt
        && Number(job.finishAt || 0) >= minuteAt);
      const level = clamp(Math.trunc(Number(general.cultivationCount) || 0), 0, CULTIVATION_RANGES.length - 1);
      const targetMinutes = training
        ? GENERAL_TRAINING_EXPERIENCE_MINUTES[level]
        : GENERAL_IDLE_EXPERIENCE_MINUTES[level];
      amount += required / targetMinutes;
    }
    general.experienceUpdatedAt = cursor + minutes * MINUTE;
    const gained = grantGeneralExperience(general, amount);
    if (gained > 0) effects.push({
      type: "general-experience-gained",
      source: "deployed",
      generalId,
      accountId: general.holderAccountId,
      amount: gained,
      experience: general.experience,
      required
    });
  }
  return effects;
}

function powerTrainingCost(basePowerValue, currentLevelValue, levelsValue = 1) {
  const basePower = clamp(Math.trunc(Number(basePowerValue) || DEFAULT_PLAYER_BASE_POWER), 1, 100000);
  const currentLevel = clamp(Math.trunc(Number(currentLevelValue) || 0), 0, MAX_TRAINING_LEVEL);
  const levels = clamp(Math.trunc(Number(levelsValue) || 1), 1, Math.min(TRAINING_BATCH_MAX, MAX_TRAINING_LEVEL - currentLevel || 1));
  const baseCost = Math.max(50, Math.ceil(basePower * 0.2));
  let total = 0;
  for (let offset = 0; offset < levels; offset += 1) total += Math.ceil(baseCost * Math.pow(TRAINING_COST_GROWTH, currentLevel + offset));
  return total;
}

function powerTrainingDurationMs(currentLevelValue, levelsValue = 1) {
  const currentLevel = clamp(Math.trunc(Number(currentLevelValue) || 0), 0, MAX_TRAINING_LEVEL);
  const levels = clamp(Math.trunc(Number(levelsValue) || 1), 1, TRAINING_BATCH_MAX);
  let total = 0;
  for (let offset = 0; offset < levels; offset += 1) total += MINUTE * (1 + Math.floor((currentLevel + offset) / 10));
  return clamp(total, MINUTE, HOUR);
}

function powerTrainingQuote(target, levelsValue = 1) {
  ensurePowerProgress(target);
  const remaining = MAX_TRAINING_LEVEL - target.trainingLevel;
  if (remaining < 1) throw new Error("该角色已经达到当前修炼上限");
  const levels = integer(levelsValue, "修炼级数", 1, Math.min(TRAINING_BATCH_MAX, remaining));
  return {
    levels,
    fromLevel: target.trainingLevel,
    toLevel: target.trainingLevel + levels,
    cost: powerTrainingCost(target.basePower, target.trainingLevel, levels),
    durationMs: powerTrainingDurationMs(target.trainingLevel, levels),
    currentPower: target.power,
    nextPower: trainingPower(target.basePower, target.trainingLevel + levels)
  };
}

function marchDurationMs(distance) {
  return clamp(Math.trunc(Number(distance) || 0), 1, GRID_SIZE * GRID_SIZE - 1) * MARCH_MS_PER_CELL;
}

function marchCost(distanceValue, soldiersValue, generalCountValue = 0) {
  const distance = clamp(Math.trunc(Number(distanceValue) || 0), 0, GRID_SIZE * GRID_SIZE - 1);
  const soldiers = Math.max(0, Math.trunc(Number(soldiersValue) || 0));
  const generalCount = Math.max(0, Math.trunc(Number(generalCountValue) || 0));
  return distance * (1 + Math.ceil(soldiers / 10) + generalCount * 2);
}

function roundByModifier(value, modifier, minimum = 0) {
  return Math.max(minimum, Math.round(Number(value) * (1 + Number(modifier || 0))));
}

function activeCarriedGeneralIds(player) {
  return [...new Set((player?.carriedGeneralIds || []).map(String))].slice(0, ACTIVE_CARRIED_GENERAL_LIMIT);
}

function normalizeCarriedGeneralOrder(state) {
  state.players ||= {};
  state.generals ||= {};
  for (const [accountId, player] of Object.entries(state.players)) {
    const eligible = [];
    for (const [generalId, general] of Object.entries(state.generals)) {
      if (String(general?.holderAccountId || "") !== String(accountId) || general.status !== "carried") continue;
      eligible.push(String(generalId));
    }
    const eligibleSet = new Set(eligible);
    player.carriedGeneralIds = [...new Set([...(player.carriedGeneralIds || []).map(String), ...eligible])]
      .filter(id => eligibleSet.has(id));
  }
  return state;
}

function talentSourcesFor(state, accountId, carriedGeneralIds) {
  const carried = carriedGeneralIds == null
    ? new Set(activeCarriedGeneralIds(state.players?.[accountId]))
    : new Set(carriedGeneralIds.map(String));
  return Object.entries(state.generals || {}).flatMap(([generalId, general]) => {
    if (!general?.talent || String(general.holderAccountId || "") !== String(accountId)) return [];
    if (general.status === "deployed") return [{ generalId, holderAccountId: accountId, status: "deployed", location: general.location, talent: general.talent }];
    if (carried.has(generalId) && general.status === "carried") return [{ generalId, holderAccountId: accountId, status: "carried", location: null, talent: general.talent }];
    return [];
  });
}

function actionTalentModifiers(state, accountId, action, position, options = {}) {
  const info = staticCell(state.seed, position.x, position.y);
  const cell = state.cells?.[keyOf(position.x, position.y)] || {};
  const sources = talentSourcesFor(state, accountId, options.carriedGeneralIds);
  for (const [generalId, general] of Object.entries(state.generals || {})) {
    if (!general?.talent || general.status !== "deployed" || String(general.holderAccountId || "") === String(accountId)) continue;
    const dx = Math.abs(Number(general.location?.x) - Number(position.x));
    const dy = Math.abs(Number(general.location?.y) - Number(position.y));
    if (Math.max(dx, dy) === 1) sources.push({ generalId, holderAccountId: general.holderAccountId, status: "deployed", location: general.location, talent: general.talent });
  }
  return talentModifiers(state, {
    action,
    actorAccountId: accountId,
    position,
    cell: { ...info, ...cell, terrain: info.terrain, population: info.population, resourceGrade: info.resourceGrade, resourceRank: info.resourceRank },
    attacking: Boolean(options.attacking),
    armySize: Number(options.armySize || 0),
    discoveryKind: options.discoveryKind || null,
    now: options.now,
    talents: sources
  });
}

function materialInventoryState(privatePlayer) {
  const source = privatePlayer?.materials && typeof privatePlayer.materials === "object" ? privatePlayer.materials : {};
  return Object.freeze(Object.fromEntries(MATERIAL_IDS.map(id => [id, Math.max(0, Math.trunc(Number(source[id]) || 0))])));
}

function ensureMaterialInventory(privatePlayer) {
  privatePlayer.materials = { ...materialInventoryState(privatePlayer) };
  return privatePlayer.materials;
}

function generalTalentState(general, seed = "legacy-grid-talent") {
  ensureGeneralTalent(general, seed);
  return Object.freeze({ talent: clone(general.talent), description: describeTalent(general.talent), cultivationCount: general.cultivationCount });
}

function cultivationQuote(target, player, nowValue = Date.now(), options = {}) {
  if (!target || !player) throw new Error("缺少修炼对象或玩家");
  const state = options.state || null;
  const targetType = options.targetType === "player" ? "player" : "general";
  if (targetType === "general") {
    ensureGeneralTalent(target, state?.seed);
    if (target.status === "deployed") throw new Error("部署中的将领不能修炼");
    if (target.status === "captured") throw new Error("俘虏不能修炼");
  }
  const cultivationCount = clamp(Math.trunc(Number(target.cultivationCount) || 0), 0, CULTIVATION_RANGES.length);
  if (cultivationCount >= CULTIVATION_RANGES.length) throw new Error(`${targetType === "player" ? "玩家" : "该将领"}已经完成五次修炼`);
  const range = CULTIVATION_RANGES[cultivationCount];
  const now = Number(nowValue);
  const unlockAt = 0;
  const goldMultiplier = targetType === "player" ? PLAYER_CULTIVATION_GOLD_MULTIPLIER : 1;
  const goldMin = Math.ceil(range.goldMin * goldMultiplier);
  const goldMax = Math.ceil(range.goldMax * goldMultiplier);
  const investment = integer(options.goldInvestment ?? goldMin, "修炼投入", goldMin, goldMax);
  const material = targetType === "general" && options.materialId != null ? String(options.materialId) : null;
  if (targetType === "general" && material != null && !CULTIVATION_MATERIAL_IDS.includes(material)) throw new Error("请选择一件有效的天赋素材");
  const position = player.position || { x: 0, y: 0 };
  const modifiers = state ? actionTalentModifiers(state, player.accountId, "cultivation", position, {
    carriedGeneralIds: targetType === "general" && target.status === "carried" ? [target.id] : activeCarriedGeneralIds(player), now
  }) : { cultivationCost: 0, cultivationPower: 0, applied: [], evaluatedTalents: 0 };
  const cost = roundByModifier(investment, modifiers.cultivationCost, 1);
  const investmentRatio = (investment - goldMin) / Math.max(1, goldMax - goldMin);
  const targetPowerMultiplier = targetType === "player" ? PLAYER_CULTIVATION_POWER_MULTIPLIER : 1;
  const baseGain = (range.powerGainMin + investmentRatio * (range.powerGainMax - range.powerGainMin)) * targetPowerMultiplier;
  const targetKey = String(target.id || target.accountId || player.accountId || targetType);
  const randomFactor = 0.9 + randomUnit(String(options.seed ?? state?.seed ?? "cultivation"), "cultivation-power", targetKey, range.attempt) * 0.2;
  const powerGainFraction = Math.min(0.75, baseGain * randomFactor * (1 + modifiers.cultivationPower));
  const currentPower = generalPower(target);
  const targetPower = currentPower + Math.max(1, Math.round(currentPower * powerGainFraction));
  const currentBasePower = clamp(Math.trunc(Number(target.basePower || target.power || 1)), 1, 100000);
  let nextBasePower = clamp(Math.ceil(currentBasePower * targetPower / Math.max(1, currentPower)), currentBasePower, 100000);
  while (nextBasePower < 100000 && trainingPower(nextBasePower, target.trainingLevel) < targetPower) nextBasePower += 1;
  while (nextBasePower > currentBasePower && trainingPower(nextBasePower - 1, target.trainingLevel) >= targetPower) nextBasePower -= 1;
  const nextPower = trainingPower(nextBasePower, target.trainingLevel);
  const powerGain = Math.max(0, nextPower - currentPower);
  if (targetType === "general") ensureGeneralExperience(target);
  const experienceRequired = targetType === "general" ? generalExperienceRequirement(target) : 0;
  const experience = targetType === "general" ? Number(target.experience || 0) : 0;
  return Object.freeze({
    attempt: range.attempt, unlockAt, unlocked: Number.isFinite(now) && now >= unlockAt, gateHours: range.gateHours,
    goldMin, goldMax, goldInvestment: investment, cost,
    materialId: material, materialCount: targetType === "general" ? 1 : 0, remaining: CULTIVATION_RANGES.length - cultivationCount,
    experience, experienceRequired, experienceReady: targetType !== "general" || experience >= experienceRequired,
    durationMs: 0,
    randomFactor: Math.round(randomFactor * 10000) / 10000,
    basePowerGainPercent: Math.round(baseGain * 10000) / 100,
    powerGainPercent: currentPower ? Math.round((powerGain / currentPower) * 10000) / 100 : 0,
    currentPower, powerGain, basePowerGain: nextBasePower - currentBasePower, nextPower,
    modifiers
  });
}

function cultivationActionQuote(state, accountId, generalId, goldInvestment, materialId, nowValue) {
  const player = ensurePlayer(state, String(accountId));
  const general = state.generals?.[String(generalId)];
  if (!general || String(general.holderAccountId) !== String(accountId)) throw new Error("只能修炼自己的将领");
  const quote = cultivationQuote(general, player, nowValue, { state, goldInvestment, materialId });
  if (!quote.unlocked) throw new Error(`第${quote.attempt}次修炼尚未开放`);
  if (!quote.experienceReady) throw new Error(`将领经验不足，需要 ${quote.experienceRequired} 经验才能修炼`);
  return quote;
}

function playerCultivationActionQuote(state, accountId, goldInvestment, nowValue) {
  const player = ensurePlayer(state, String(accountId));
  const quote = cultivationQuote(player, player, nowValue, { state, targetType: "player", goldInvestment });
  if (!quote.unlocked) throw new Error(`第${quote.attempt}次修炼尚未开放`);
  return quote;
}

function marchQuote(state, accountId, toValue, soldiersValue = 0, _generalIdsValue, attacking = false, nowValue = Date.now()) {
  const player = ensurePlayer(state, String(accountId));
  const from = { x: coordinate(player.position?.x, "玩家所在地横坐标"), y: coordinate(player.position?.y, "玩家所在地纵坐标") };
  const to = { x: coordinate(toValue?.x, "目标横坐标"), y: coordinate(toValue?.y, "目标纵坐标") };
  const path = findMarchPath(state, accountId, from, to, { attack: Boolean(attacking) });
  if (!path) throw new Error("没有可通行的行军路径");
  const distance = path.length;
  if (!distance && !attacking) throw new Error("目标位置与当前位置相同");
  const soldiers = integer(soldiersValue, "携带士兵", 0, 1000000);
  const generalIds = [...new Set((player.carriedGeneralIds || []).map(String))];
  const activeGeneralIds = generalIds.slice(0, ACTIVE_CARRIED_GENERAL_LIMIT);
  const modifiers = actionTalentModifiers(state, accountId, "march", to, { attacking, armySize: soldiers, carriedGeneralIds: activeGeneralIds, now: nowValue });
  const baseCost = marchCost(distance, soldiers, generalIds.length);
  const baseDurationMs = marchDurationMs(distance);
  return Object.freeze({
    from, to, path, distance, soldiers, generalIds, activeGeneralIds,
    baseCost, cost: distance ? roundByModifier(baseCost, modifiers.marchCost, 1) : 0,
    baseDurationMs, durationMs: distance ? roundByModifier(baseDurationMs, modifiers.marchDuration, 1) : 0,
    modifiers
  });
}

function ordinaryTreasureMaterial(seed, epoch, index) {
  const roll = randomUnit(seed, "treasure-material", epoch, index);
  if (roll < 0.06) return "gold";
  if (roll < 0.18) return "purple";
  if (roll < 0.4) return "blue";
  if (roll < 0.7) return "green";
  return "white";
}

function scatterTreasures(state, options = {}, nowValue = Date.now()) {
  state.treasureSpawns ||= {};
  state.claimedTreasures ||= {};
  const count = integer(options.count ?? 240, "宝物数量", 0, GRID_SIZE * GRID_SIZE);
  const redAscend = integer(options.redAscend ?? 0, "赤曜丹·升格数量", 0, count);
  const redReroll = integer(options.redReroll ?? 0, "赤曜丹·洗髓数量", 0, count - redAscend);
  const epoch = Math.max(0, Math.trunc(Number(state.treasureEpoch) || 0)) + 1;
  const available = [];
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      if (!state.cells?.[keyOf(x, y)]?.ownerAccountId) {
        available.push({ x, y, order: entropy(state.seed, "treasure-scatter", state.seasonId, epoch, x, y).toString("hex") });
      }
    }
  }
  available.sort((left, right) => left.order.localeCompare(right.order));
  if (count > available.length) throw new Error(`未占领区域只能容纳 ${available.length} 个宝物`);
  const redMaterials = [
    ...Array.from({ length: redAscend }, () => "red-ascend"),
    ...Array.from({ length: redReroll }, () => "red-reroll")
  ];
  const spawns = {};
  for (let index = 0; index < count; index += 1) {
    const location = available[index];
    const materialId = redMaterials[index] || ordinaryTreasureMaterial(state.seed, epoch, index);
    const id = `treasure-${epoch}-${index + 1}`;
    spawns[id] = { id, epoch, x: location.x, y: location.y, materialId, spawnedAt: Number(nowValue) };
  }
  state.treasureSpawns = spawns;
  state.treasureEpoch = epoch;
  return treasureState(state);
}

function treasureState(state) {
  return Object.freeze({
    epoch: Math.max(0, Math.trunc(Number(state?.treasureEpoch) || 0)),
    active: clone(state?.treasureSpawns || {}),
    claimed: clone(state?.claimedTreasures || {})
  });
}

function claimTreasureAt(state, accountId, position, now, effects) {
  const entry = Object.values(state.treasureSpawns || {}).find(item => item.x === position.x && item.y === position.y);
  if (!entry || state.claimedTreasures?.[entry.id]) return null;
  const privatePlayer = state.privatePlayers[accountId] ||= { orientation: "any" };
  const materials = ensureMaterialInventory(privatePlayer);
  materials[entry.materialId] = Number(materials[entry.materialId] || 0) + 1;
  state.claimedTreasures ||= {};
  const claim = {
    treasureId: entry.id, epoch: entry.epoch, x: entry.x, y: entry.y,
    accountId: String(accountId), claimedAt: Number(now)
  };
  state.claimedTreasures[entry.id] = claim;
  delete state.treasureSpawns[entry.id];
  effects.push({ type: "treasure-claimed", ...claim, materialId: entry.materialId, amount: 1 });
  return { ...claim, materialId: entry.materialId, amount: 1 };
}

function generalPower(general) {
  return trainingPower(general?.basePower ?? general?.power, general?.trainingLevel || 0);
}

function regionPower(state, x, y) {
  const cell = dynamicCell(state, x, y);
  return Number(cell.soldiers || 0) + (cell.generalIds || []).reduce((total, id) => total + generalPower(state.generals[id]), 0);
}

function regionDefenseQuote(state, xValue, yValue, nowValue = Date.now()) {
  const x = coordinate(xValue, "横坐标");
  const y = coordinate(yValue, "纵坐标");
  const cell = state.cells?.[keyOf(x, y)] || { ownerAccountId: null, soldiers: 0, generalIds: [] };
  const basePower = regionPower(state, x, y);
  const cultivationBonusPower = (cell.generalIds || []).reduce((total, id) => {
    const general = state.generals?.[id];
    return total + (general?.status === "deployed" ? generalDefenseBonusPower(general) : 0);
  }, 0);
  if (!cell.ownerAccountId) return Object.freeze({ x, y, ownerAccountId: null, basePower, cultivationBonusPower: 0, talentBonusPower: 0, power: basePower, modifiers: null });
  const modifiers = actionTalentModifiers(state, cell.ownerAccountId, "combat", { x, y }, {
    attacking: false, armySize: Number(cell.soldiers || 0), carriedGeneralIds: [], now: nowValue
  });
  const powerBeforeTalents = basePower + cultivationBonusPower;
  const power = Math.max(0, Math.round(powerBeforeTalents * (1 + modifiers.combatPower + modifiers.defensePower)));
  return Object.freeze({
    x, y, ownerAccountId: cell.ownerAccountId, basePower, cultivationBonusPower,
    talentBonusPower: Math.max(0, power - powerBeforeTalents), power, modifiers
  });
}

function pathBetween(from, to) {
  const fromX = coordinate(from?.x, "起点横坐标");
  const fromY = coordinate(from?.y, "起点纵坐标");
  const toX = coordinate(to?.x, "目标横坐标");
  const toY = coordinate(to?.y, "目标纵坐标");
  const path = [];
  let x = fromX;
  let y = fromY;
  while (x !== toX && path.length <= GRID_SIZE * 2) { x += Math.sign(toX - x); path.push({ x, y }); }
  while (y !== toY && path.length <= GRID_SIZE * 2) { y += Math.sign(toY - y); path.push({ x, y }); }
  if (path.length > (GRID_SIZE - 1) * 2 || x !== toX || y !== toY) throw new Error("行军路径超出地图范围");
  return path;
}

function storedMarchPath(value) {
  if (!Array.isArray(value)) return null;
  const path = [];
  for (const point of value) {
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)
      || point.x < 0 || point.x >= GRID_SIZE || point.y < 0 || point.y >= GRID_SIZE) return null;
    path.push({ x: point.x, y: point.y });
  }
  return path;
}

function marchCellOwner(state, point) {
  return state.cells?.[keyOf(point.x, point.y)]?.ownerAccountId || null;
}

function samePoint(left, right) {
  return Boolean(left && right && left.x === right.x && left.y === right.y);
}

function routeIsCurrent(state, accountId, path, to, attack) {
  return path.every((point, index) => {
    const owner = marchCellOwner(state, point);
    const target = index === path.length - 1 && samePoint(point, to);
    return !owner || String(owner) === String(accountId) || (target && attack);
  });
}

// Four-neighbour BFS keeps quotes, queued jobs and settlement on one route.
// Other players' cells are walls; an attacked enemy cell may only be the end.
function findMarchPath(state, accountIdValue, fromValue, toValue, options = {}) {
  const accountId = String(accountIdValue || "");
  const from = { x: coordinate(fromValue?.x, "起点横坐标"), y: coordinate(fromValue?.y, "起点纵坐标") };
  const to = { x: coordinate(toValue?.x, "目标横坐标"), y: coordinate(toValue?.y, "目标纵坐标") };
  const attack = Boolean(options.attack);
  if (samePoint(from, to)) return [];

  const player = state.players?.[accountId];
  const originOwner = marchCellOwner(state, from);
  if (originOwner && String(originOwner) !== accountId) {
    const retreat = storedMarchPath(player?.retreatPath);
    if (!retreat?.length || !samePoint(retreat[0], from) || !samePoint(retreat[retreat.length - 1], to)) return null;
    const path = retreat.slice(1);
    return routeIsCurrent(state, accountId, path, to, attack) ? path : null;
  }

  const targetOwner = marchCellOwner(state, to);
  if (targetOwner && String(targetOwner) !== accountId && !attack) return null;
  const startKey = keyOf(from.x, from.y);
  const targetKey = keyOf(to.x, to.y);
  const queue = [from];
  const previous = new Map([[startKey, null]]);
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    if (samePoint(current, to)) break;
    const dx = Math.sign(to.x - current.x);
    const dy = Math.sign(to.y - current.y);
    const directions = [];
    if (dx) directions.push([dx, 0]);
    if (dy) directions.push([0, dy]);
    if (dx) directions.push([-dx, 0]);
    if (dy) directions.push([0, -dy]);
    if (!dx) directions.push([1, 0], [-1, 0]);
    if (!dy) directions.push([0, 1], [0, -1]);
    const seenDirections = new Set();
    for (const [stepX, stepY] of directions) {
      const directionKey = `${stepX},${stepY}`;
      if (seenDirections.has(directionKey)) continue;
      seenDirections.add(directionKey);
      const next = { x: current.x + stepX, y: current.y + stepY };
      if (next.x < 0 || next.x >= GRID_SIZE || next.y < 0 || next.y >= GRID_SIZE) continue;
      const nextKey = keyOf(next.x, next.y);
      if (previous.has(nextKey)) continue;
      const owner = marchCellOwner(state, next);
      const isTarget = nextKey === targetKey;
      if (owner && String(owner) !== accountId && !(isTarget && attack)) continue;
      previous.set(nextKey, keyOf(current.x, current.y));
      queue.push(next);
    }
  }
  if (!previous.has(targetKey)) return null;
  const reversed = [];
  let currentKey = targetKey;
  while (currentKey !== startKey) {
    const [x, y] = currentKey.split(",").map(Number);
    reversed.push({ x, y });
    currentKey = previous.get(currentKey);
  }
  return reversed.reverse();
}

function rememberMarchRoute(player, job, path) {
  const route = [{ ...job.from }, ...path.map(point => ({ ...point }))];
  player.retreatPath = route.reverse();
}

function returnArmy(state, player, job, soldiers) {
  const amount = Math.max(0, Number(soldiers || 0));
  const origin = dynamicCell(state, job.from.x, job.from.y);
  if (origin.ownerAccountId !== job.accountId) {
    player.fieldArmySoldiers = Number(player.fieldArmySoldiers || 0) + amount;
    return;
  }
  const capacity = staticCell(state.seed, job.from.x, job.from.y).garrisonCap;
  const accepted = Math.max(0, Math.min(amount, capacity - Number(origin.soldiers || 0)));
  origin.soldiers += accepted;
  player.fieldArmySoldiers = Number(player.fieldArmySoldiers || 0) + amount - accepted;
}

// Player-versus-player battles use the same power values that decide the
// winner to derive losses.  Generals contribute power, but only soldiers are
// removed; a general itself is never a casualty.
function battleCasualties(attackerPowerValue, defenderPowerValue, attackerSoldiersValue, defenderSoldiersValue) {
  const attackerPower = Math.max(1, Number(attackerPowerValue) || 0);
  const defenderPower = Math.max(1, Number(defenderPowerValue) || 0);
  const attackerSoldiers = Math.max(0, Math.trunc(Number(attackerSoldiersValue) || 0));
  const defenderSoldiers = Math.max(0, Math.trunc(Number(defenderSoldiersValue) || 0));
  const attackerWon = attackerPower > defenderPower;
  const loserPower = attackerWon ? defenderPower : attackerPower;
  const winnerPower = attackerWon ? attackerPower : defenderPower;
  const loserSoldiers = attackerWon ? defenderSoldiers : attackerSoldiers;
  const winnerSoldiers = attackerWon ? attackerSoldiers : defenderSoldiers;
  const loserLosses = Math.min(loserSoldiers, Math.floor(loserPower * 0.8));
  const winnerLosses = Math.min(
    winnerSoldiers,
    Math.floor(0.9 * loserPower * loserPower / Math.max(1, winnerPower)),
    Math.floor(winnerPower * 0.9)
  );
  return Object.freeze({
    attackerWon,
    attackerLosses: attackerWon ? winnerLosses : loserLosses,
    defenderLosses: attackerWon ? loserLosses : winnerLosses,
    attackerSurvivors: Math.max(0, attackerSoldiers - (attackerWon ? winnerLosses : loserLosses)),
    defenderSurvivors: Math.max(0, defenderSoldiers - (attackerWon ? loserLosses : winnerLosses))
  });
}

function battleReportsFor(state, accountId) {
  state.privatePlayers ||= {};
  const privatePlayer = state.privatePlayers[String(accountId)] ||= { orientation: "any" };
  if (!Array.isArray(privatePlayer.battleReports)) privatePlayer.battleReports = [];
  return privatePlayer.battleReports;
}

function battleReportSummary(report, state = null) {
  if (!report || typeof report !== "object") return "";
  const parts = [
    report.outcome === "victory" ? "我方获胜并占领目标" : "我方战败并返回出发地",
    `双方战力 ${Math.max(0, Math.trunc(Number(report.attackerPower || 0)))}/${Math.max(0, Math.trunc(Number(report.defenderPower || 0)))}`
  ];
  if (Number(report.soldiersGained || 0) > 0) parts.push(`获得士兵 ${Math.trunc(Number(report.soldiersGained))}`);
  if (Number(report.ownLosses || 0) > 0) parts.push(`我方牺牲 ${Math.trunc(Number(report.ownLosses))} 名士兵`);
  if (Number(report.ownSurvivors || 0) > 0) parts.push(`我方幸存 ${Math.trunc(Number(report.ownSurvivors))} 名士兵`);
  const capturedNames = (report.capturedGenerals || []).map(item => String(item?.name || state?.generals?.[item?.id]?.name || "").trim()).filter(Boolean);
  if (capturedNames.length) parts.push(`俘虏将领：${capturedNames.join("、")}`);
  const discoveredName = String(report.discoveredGeneralName || "").trim();
  if (discoveredName) parts.push(`发掘将领：${discoveredName}`);
  else if (report.discoveryId) parts.push("发现一名待提拔的拔尖兵士");
  const target = report.target || {};
  return `战报：于 (${Number(target.x)}, ${Number(target.y)}) 发动进攻，${parts.join("；")}。`;
}

function recordBattleReport(state, accountId, value) {
  const reports = battleReportsFor(state, accountId);
  const id = String(value?.id || value?.jobId || crypto.randomUUID()).slice(0, 100);
  const report = {
    id,
    jobId: String(value?.jobId || id).slice(0, 100),
    createdAt: Number(value?.createdAt || Date.now()),
    target: { x: coordinate(value?.target?.x, "战报横坐标"), y: coordinate(value?.target?.y, "战报纵坐标") },
    outcome: value?.outcome === "victory" ? "victory" : "defeat",
    attackerPower: Math.max(0, Math.trunc(Number(value?.attackerPower || 0))),
    defenderPower: Math.max(0, Math.trunc(Number(value?.defenderPower || 0))),
    soldiersGained: Math.max(0, Math.trunc(Number(value?.soldiersGained || 0))),
    ownLosses: Math.max(0, Math.trunc(Number(value?.ownLosses || 0))),
    ownSurvivors: Math.max(0, Math.trunc(Number(value?.ownSurvivors || 0))),
    capturedGenerals: (value?.capturedGeneralIds || []).map(idValue => ({
      id: String(idValue),
      name: String(state.generals?.[idValue]?.name || "无名将领").slice(0, 24)
    })),
    discoveryId: value?.discoveryId ? String(value.discoveryId).slice(0, 120) : null,
    discoveredGeneralId: value?.discoveredGeneralId ? String(value.discoveredGeneralId).slice(0, 120) : null,
    discoveredGeneralName: value?.discoveredGeneralName ? String(value.discoveredGeneralName).slice(0, 24) : ""
  };
  const existing = reports.findIndex(item => String(item?.id || "") === id);
  if (existing >= 0) reports.splice(existing, 1, report);
  else reports.push(report);
  if (reports.length > 20) reports.splice(0, reports.length - 20);
  return report;
}

function grantMarchExperience(state, job, distance, effects) {
  for (const generalId of [...new Set((job.generalIds || []).map(String))]) {
    const general = state.generals?.[generalId];
    if (!general || String(general.holderAccountId || "") !== String(job.accountId || "")) continue;
    const gained = grantGeneralExperience(general, generalMarchExperienceGain(general, distance));
    if (gained > 0) effects.push({ type: "general-experience-gained", source: "march", generalId, accountId: job.accountId, amount: gained, experience: general.experience, required: generalExperienceRequirement(general) });
  }
}

function grantBattleExperience(state, job, activeGeneralIds, attackerPower, defenderPower, effects) {
  const difference = Math.abs(Number(attackerPower || 0) - Number(defenderPower || 0));
  for (const generalId of activeGeneralIds || []) {
    const general = state.generals?.[generalId];
    if (!general || String(general.holderAccountId || "") !== String(job.accountId || "")) continue;
    const gained = grantGeneralExperience(general, generalBattleExperienceGain(general, difference));
    if (gained > 0) effects.push({ type: "general-experience-gained", source: "battle", generalId, accountId: job.accountId, amount: gained, experience: general.experience, required: generalExperienceRequirement(general), powerDifference: difference });
  }
}

function gameYear(state, timestamp) {
  return 1 + Math.floor(Math.max(0, Number(timestamp) - Number(state.startedAt)) / (24 * HOUR));
}

function formatGeneralMemory(general) {
  const entries = Array.isArray(general?.memory?.entries) ? general.memory.entries : [];
  const recent = entries.slice(-30);
  const speech = recent.filter(entry => entry.category === "speech").map(entry => `[${entry.year}年]${entry.text}`).join("");
  const deeds = recent.filter(entry => entry.category !== "speech").map(entry => `[${entry.year}年]${entry.text}`).join("");
  return `言谈：${speech || "暂无"}\n经历：${deeds || "暂无"}`;
}

function playerDisplayName(state, accountId) {
  const id = String(accountId || "");
  return String(state?.players?.[id]?.displayName || "某位主公").trim() || "某位主公";
}

function modelMasterHistory(state, general) {
  return (general?.masterHistory || []).map(item => ({
    lordName: playerDisplayName(state, item.accountId),
    fromYear: Number(item.fromYear || 1),
    toYear: item.toYear == null ? null : Number(item.toYear),
    reason: String(item.reason || "效忠").slice(0, 40)
  }));
}

function modelCaptivityHistory(state, general) {
  return (general?.captivityHistory || []).map(item => ({
    captorName: playerDisplayName(state, item.captorAccountId),
    formerLordName: playerDisplayName(state, item.formerMasterAccountId),
    year: Number(item.year || 1)
  }));
}

function modelRecentInteractions(general) {
  return (general?.interactionHistory || []).map(item => ({
    year: Number(item.year || 1),
    speakerName: String(item.speakerName || "某位主公").slice(0, 40),
    kind: item.kind === "captive" ? "captive" : "ordinary",
    category: item.category === "deed" ? "deed" : "speech",
    summary: String(item.summary || "").slice(0, 120),
    emotion: String(item.emotion || "").slice(0, 40),
    userText: String(item.userText || "").slice(0, 240),
    reply: String(item.reply || "").slice(0, 600),
    narration: String(item.narration || "").slice(0, 600)
  }));
}

function formerLordRouting(state, general, currentAccountId) {
  const accountIds = [...new Set((general?.masterHistory || [])
    .map(item => String(item.accountId || ""))
    .filter(id => id && id !== String(currentAccountId || "")))];
  return accountIds.map((accountId, index) => ({
    recipientKey: `former-lord-${index + 1}`,
    displayName: playerDisplayName(state, accountId),
    accountId
  }));
}

function appendGeneralMemory(general, { year, category, text, accountId, intimacyDelta = 0 }) {
  general.memory ||= { entries: [], intimacy: {} };
  general.memory.entries ||= [];
  general.memory.intimacy ||= {};
  general.memory.entries.push({ year: integer(year, "年份", 1), category: category === "deed" ? "deed" : "speech", text: String(text).slice(0, 120) });
  if (general.memory.entries.length > 30) general.memory.entries.splice(0, general.memory.entries.length - 30);
  if (accountId) general.memory.intimacy[accountId] = clamp(Number(general.memory.intimacy[accountId] || 0) + Number(intimacyDelta || 0), -100, 100);
  general.memoryText = formatGeneralMemory(general).slice(0, 1000);
}

function defaultGeneralMeasurements(gender) {
  return gender === "female"
    ? { chestCm: 86, waistCm: 60, hipCm: 88 }
    : { chestCm: 98, waistCm: 78, hipCm: 96 };
}

function normalizedMeasurements(value = {}, gender = "female") {
  const source = value && typeof value === "object" ? value : {};
  const fallback = defaultGeneralMeasurements(gender);
  const bounded = (input, fallbackValue) => clamp(Math.round((Number(input) || fallbackValue) * 10) / 10, 30, 200);
  return {
    chestCm: bounded(source.chestCm, fallback.chestCm),
    waistCm: bounded(source.waistCm, fallback.waistCm),
    hipCm: bounded(source.hipCm, fallback.hipCm)
  };
}

function ensureGeneralProfile(general) {
  if (!general || typeof general !== "object") return general;
  general.gender = general.gender === "male" ? "male" : "female";
  general.heightCm = clamp(Math.round(Number(general.heightCm) || (general.gender === "female" ? 166 : 178)), 120, 230);
  general.weightKg = clamp(Math.round((Number(general.weightKg) || (general.gender === "female" ? 55 : 72)) * 10) / 10, 30, 250);
  general.measurements = normalizedMeasurements(general.measurements, general.gender);
  general.appearanceSetting = String(general.appearanceSetting || (general.gender === "female"
    ? "她保持着便于长途行军的利落装束，发式、衣甲与随身物件都收拾得井然有序；长期征战让她的姿态显得沉稳警觉，举手投足带着鲜明的军旅气质。"
    : "他保持着便于长途行军的利落装束，发式、衣甲与随身物件都收拾得井然有序；长期征战让他的姿态显得沉稳警觉，举手投足带着鲜明的军旅气质。"
  )).slice(0, 350);
  general.coreSetting = String(general.coreSetting || general.setting || "此人出身乱世，善于整军与守土，等待慧眼之主发现其才干。开局之后会根据效忠、征战与交往逐步形成更鲜明的经历和立场。" ).slice(0, MAX_GENERAL_CORE_SETTING_LENGTH);
  general.setting = general.coreSetting;
  const relistAvailableAt = Number(general.marketRelistAvailableAt || 0);
  general.marketRelistAvailableAt = Number.isFinite(relistAvailableAt) && relistAvailableAt > 0 ? relistAvailableAt : 0;
  ensurePowerProgress(general, general.power || 300);
  ensureGeneralTalent(general);
  ensureGeneralExperience(general);
  return general;
}

function publicMarketGeneralState(general) {
  // Market projections must not mutate the seller's private general. This is
  // especially important for cooldown metadata, which is intentionally not
  // part of the public listing payload.
  const normalized = clone(general && typeof general === "object" ? general : {});
  ensureGeneralProfile(normalized);
  return {
    id: String(normalized?.id || ""),
    name: String(normalized?.name || "无名将领").slice(0, 24),
    gender: normalized?.gender === "male" ? "male" : "female",
    heightCm: Number(normalized.heightCm),
    weightKg: Number(normalized.weightKg),
    measurements: clone(normalized.measurements),
    appearanceSetting: String(normalized.appearanceSetting || "").slice(0, 350),
    coreSetting: String(normalized.coreSetting || normalized.setting || "").slice(0, MAX_GENERAL_CORE_SETTING_LENGTH),
    setting: String(normalized.coreSetting || normalized.setting || "").slice(0, MAX_GENERAL_CORE_SETTING_LENGTH),
    basePower: Math.max(1, Math.trunc(Number(normalized.basePower || normalized.power || 300))),
    trainingLevel: clamp(Math.trunc(Number(normalized.trainingLevel) || 0), 0, MAX_TRAINING_LEVEL),
    power: Math.max(0, Math.trunc(Number(normalized.power || 0))),
    cultivationCount: clamp(Math.trunc(Number(normalized.cultivationCount) || 0), 0, CULTIVATION_RANGES.length),
    experience: Number(normalized.experience || 0),
    experienceRequired: generalExperienceRequirement(normalized),
    talent: clone(normalized.talent),
    talentSummary: talentSummary(normalized),
    masterHistory: clone(normalized.masterHistory || []),
    captivityHistory: clone(normalized.captivityHistory || []),
    interactionHistory: clone(normalized.interactionHistory || []),
    memory: clone(normalized.memory || { entries: [], intimacy: {} }),
    memoryText: String(normalized.memoryText || "").slice(0, 1000),
    loyalToAccountId: String(normalized.loyalToAccountId || ""),
    capturedFromAccountId: normalized.capturedFromAccountId ? String(normalized.capturedFromAccountId) : null
  };
}

function publicMarketListingState(state, listing) {
  const source = listing && typeof listing === "object" ? listing : {};
  const result = {
    listingId: String(source.listingId || ""),
    generalId: String(source.generalId || source.general?.id || ""),
    sellerAccountId: String(source.sellerAccountId || ""),
    sellerDisplayName: String(source.sellerDisplayName || state.players?.[source.sellerAccountId]?.displayName || "玩家").slice(0, 40),
    price: Math.max(1, Math.trunc(Number(source.price || 0))),
    listedAt: Number(source.listedAt || 0),
    sourceStatus: ["carried", "waiting"].includes(String(source.sourceStatus || "")) ? String(source.sourceStatus) : "carried",
    general: publicMarketGeneralState(source.general || {})
  };
  // Keep old market records readable while adding the optional seller note to
  // newly-created listings.
  if (Object.hasOwn(source, "sellerIntro")) result.sellerIntro = String(source.sellerIntro || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return result;
}

function ensureGeneralTalent(general, seed = "legacy-grid-talent") {
  if (!general || typeof general !== "object") return general;
  const id = String(general.id || "general");
  general.talent = general.talent
    ? normalizeTalent(general.talent, seed, id)
    : rollTalent(seed, id);
  general.cultivationCount = clamp(Math.trunc(Number(general.cultivationCount) || 0), 0, CULTIVATION_RANGES.length);
  ensureGeneralExperience(general);
  return general;
}

function talentSummary(general, seed = "legacy-grid-talent") {
  ensureGeneralTalent(general, seed);
  const definition = TALENT_BY_ID[general.talent.talentId];
  return Object.freeze({
    name: definition?.name || general.talent.talentId,
    rarity: general.talent.rarity,
    effectPercent: general.talent.potencyPercent,
    text: describeTalent(general.talent)
  });
}

function deployedGeneralAveragePower(state) {
  const powers = Object.values(state.generals || {})
    .filter(general => general.status === "deployed")
    .map(general => generalPower(general));
  return powers.length ? Math.round(powers.reduce((sum, power) => sum + power, 0) / powers.length) : 0;
}

function opposingDeployedGeneralAveragePower(state, accountId) {
  const powers = Object.values(state.generals || {})
    .filter(general => general.status === "deployed" && String(general.holderAccountId) !== String(accountId))
    .map(general => generalPower(general));
  return powers.length ? Math.round(powers.reduce((sum, power) => sum + power, 0) / powers.length) : 0;
}

function createFallbackGeneral({ id = crypto.randomUUID(), name, gender, heightCm, weightKg, measurements, appearanceSetting, coreSetting, setting, power, holderAccountId, holderName, year = 1, talentSeed }) {
  const normalizedCore = String(coreSetting || setting || "此人出身乱世，善于整军与守土，等待慧眼之主发现其才干。").slice(0, MAX_GENERAL_CORE_SETTING_LENGTH);
  const general = {
    id: String(id),
    name: String(name || (gender === "female" ? "无名女将" : "无名将领")).slice(0, 24),
    gender: gender === "female" ? "female" : "male",
    heightCm: clamp(Math.round(Number(heightCm) || (gender === "female" ? 166 : 178)), 120, 230),
    weightKg: clamp(Math.round((Number(weightKg) || (gender === "female" ? 55 : 72)) * 10) / 10, 30, 250),
    measurements: normalizedMeasurements(measurements, gender),
    appearanceSetting: String(appearanceSetting || "").slice(0, 350),
    coreSetting: normalizedCore,
    setting: normalizedCore,
    basePower: integer(power ?? 300, "将领基础战力", 1, 100000),
    trainingLevel: 0,
    power: integer(power ?? 300, "将领战力", 1, 100000),
    cultivationCount: 0,
    experience: 0,
    experienceUpdatedAt: 0,
    talent: rollTalent(String(talentSeed || holderAccountId || "general"), String(id)),
    holderAccountId: String(holderAccountId),
    loyalToAccountId: String(holderAccountId),
    status: "carried",
    location: null,
    masterHistory: [{ accountId: String(holderAccountId), fromYear: year, toYear: null, reason: "发掘" }],
    captivityHistory: [],
    interactionHistory: [],
    memory: { entries: [], intimacy: { [String(holderAccountId)]: 5 } },
    memoryText: ""
  };
  ensureGeneralProfile(general);
  appendGeneralMemory(general, { year, category: "deed", text: `被${String(holderName || "某位主公").slice(0, 40)}发掘并提拔为将领`, accountId: holderAccountId, intimacyDelta: 5 });
  return general;
}

function generatedGeneralPower(seed, accountId, sourceId = "general") {
  return 250 + (entropy(String(seed), "generated-general-power", String(accountId), String(sourceId)).readUInt32BE(0) % 101);
}

function closeCurrentMaster(general, year) {
  const current = [...(general.masterHistory || [])].reverse().find(item => item.toYear == null);
  if (current) current.toYear = year;
}

function canInteractWithGeneral(state, player, general) {
  if (!general || general.holderAccountId !== player.accountId) return false;
  if (player.carriedGeneralIds?.includes(general.id)) return true;
  if (general.status === "captured") return true;
  return general.status === "deployed"
    && general.location?.x === player.position?.x
    && general.location?.y === player.position?.y;
}

function settleWorld(inputState, nowValue = Date.now(), options = {}) {
  const state = clone(inputState);
  const now = Number(nowValue);
  if (!Number.isFinite(now) || now < state.startedAt) throw new Error("宿主时间无效");
  state.jobs ||= {};
  state.privatePlayers ||= {};
  state.generals ||= {};
  normalizeCarriedGeneralOrder(state);
  for (const player of Object.values(state.players || {})) {
    ensurePowerProgress(player, DEFAULT_PLAYER_BASE_POWER);
    player.cultivationCount = clamp(Math.trunc(Number(player.cultivationCount) || 0), 0, CULTIVATION_RANGES.length);
  }
  for (const general of Object.values(state.generals)) ensureGeneralTalent(general, state.seed);
  for (const privatePlayer of Object.values(state.privatePlayers)) ensureMaterialInventory(privatePlayer);
  const effects = [];
  accrueDeployedGeneralExperience(state, now, options.experienceSince, effects, options.activeAccountId);
  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (job.type === "mining") {
      const cell = dynamicCell(state, job.x, job.y);
      const player = state.players[job.accountId];
      if (!player || cell.ownerAccountId !== job.accountId) {
        delete state.jobs[jobId];
        effects.push({ type: "mining-stopped", reason: "territory-lost", jobId, accountId: job.accountId, x: job.x, y: job.y });
        continue;
      }
      const info = staticCell(state.seed, job.x, job.y);
      const finishAt = Number(job.finishAt || (Number(job.startedAt || job.lastSettledAt || now) + MINING_DURATION_MS));
      if (now < finishAt) continue;
      const currentFormula = Number(job.yieldFormulaVersion || 0) >= RESOURCE_YIELD_FORMULA_VERSION;
      const storedCycleMs = Math.max(1000, Number(job.cycleMs) || MINUTE);
      const completedCycles = currentFormula ? 1 : Math.max(1, Math.min(1440, Math.floor((now - Number(job.lastSettledAt || job.startedAt || now)) / storedCycleMs)));
      const yieldPerCycle = currentFormula
        ? Math.max(1, Math.trunc(Number(job.yieldPerCycle) || 0))
        : Math.max(1, Math.trunc(Number(job.yieldPerCycle) || roundByModifier(resourceYield(info), job.modifiers?.miningYield, 1)));
      const gold = completedCycles * yieldPerCycle;
      player.gold += gold;
      const cooldownMs = miningCooldownMs(info);
      const availableAt = finishAt + cooldownMs;
      miningCooldownsFor(state, job.accountId)[keyOf(job.x, job.y)] = availableAt;
      delete state.jobs[jobId];
      effects.push({
        type: "mining-complete", jobId, accountId: job.accountId, x: job.x, y: job.y,
        cycles: completedCycles, gold, cooldownMs, availableAt
      });
      continue;
    }
    if (now < Number(job.finishAt)) continue;
    if (job.type === "training") {
      const cell = dynamicCell(state, job.x, job.y);
      if (cell.ownerAccountId !== job.accountId || !state.players[job.accountId]) {
        effects.push({ type: "training-cancelled", reason: "territory-lost", jobId, accountId: job.accountId, x: job.x, y: job.y, soldiers: 0 });
        delete state.jobs[jobId];
        continue;
      }
      const info = staticCell(state.seed, job.x, job.y);
      const trainedAmount = Math.max(0, Number(job.outputAmount ?? job.amount) || 0);
      const accepted = Math.max(0, Math.min(trainedAmount, info.garrisonCap - Number(cell.soldiers || 0)));
      cell.soldiers += accepted;
      effects.push({ type: "training-complete", jobId, accountId: job.accountId, x: job.x, y: job.y, soldiers: accepted });
      if (accepted > 0) {
        const privatePlayer = state.privatePlayers[job.accountId] ||= { orientation: "any" };
        const discoveryModifiers = actionTalentModifiers(state, job.accountId, "discovery", { x: job.x, y: job.y }, {
          armySize: accepted, discoveryKind: "training", now
        });
        const deployedCount = deployedGeneralIdsAt(state, job.accountId, job.x, job.y).length;
        const deploymentMultiplier = 2 ** deployedCount;
        const discoveryWindow = normalizeTrainingDiscoveryWindow(privatePlayer);
        let remaining = accepted;
        let segment = 0;
        while (remaining > 0) {
          const room = 1000 - discoveryWindow.trained;
          const chunk = Math.min(remaining, room);
          const discoveryChance = clamp(
            (trainingGeneralDiscoveryChance(chunk) + Number(discoveryModifiers.discoveryChance || 0)) * deploymentMultiplier,
            0, 1
          );
          if (!discoveryWindow.discovered
            && randomUnit(state.seed, "discover-general-training", state.seasonId, job.id, job.x, job.y, segment, discoveryWindow.trained) < discoveryChance) {
            const orientation = privatePlayer.orientation || "any";
            const sourceId = segment ? `${job.id}:${segment}` : job.id;
            effects.push({
              type: "general-generation-request",
              sourceKind: "training",
              sourceId,
              accountId: job.accountId,
              x: job.x,
              y: job.y,
              gender: allowedGeneralGender(orientation, state.seed, job.id, "training", segment),
              directionTags: selectGeneralDirectionTags(privatePlayer, state.seed, state.seasonId, job.id, job.x, job.y, "training", segment),
              initial: false,
              population: info.population,
              resourceGrade: info.resourceGrade,
              trainedSoldiers: chunk,
              discoveryChance,
              deployedGeneralCount: deployedCount,
              deploymentMultiplier,
              createdAt: now
            });
            const candidate = effects[effects.length - 1];
            candidate.discoveryId = `training:${sourceId}`;
            queueGeneralDiscovery(state, candidate);
            discoveryWindow.discovered = true;
          }
          discoveryWindow.trained += chunk;
          remaining -= chunk;
          segment += 1;
          if (discoveryWindow.trained >= 1000) {
            discoveryWindow.trained = 0;
            discoveryWindow.discovered = false;
          }
        }
      }
      delete state.jobs[jobId];
      continue;
    }
    if (job.type === "general-cultivation") {
      const player = state.players[job.accountId];
      const general = state.generals[job.generalId];
      const valid = player && general
        && String(general.holderAccountId) === String(job.accountId)
        && general.status !== "deployed" && general.status !== "captured"
        && Number(general.cultivationCount || 0) === Number(job.fromCultivationCount || 0);
      if (!valid) {
        if (player) player.gold += Math.max(0, Number(job.cost || 0));
        if (state.privatePlayers[job.accountId]) {
          const materials = ensureMaterialInventory(state.privatePlayers[job.accountId]);
          materials[job.materialId] = Number(materials[job.materialId] || 0) + 1;
        }
        effects.push({ type: "general-cultivation-cancelled", reason: "target-unavailable", jobId, accountId: job.accountId, generalId: job.generalId });
        delete state.jobs[jobId];
        continue;
      }
      ensurePowerProgress(general, job.basePower);
      general.basePower = clamp(Number(general.basePower) + Number(job.basePowerGain || 0), 1, 100000);
      general.power = trainingPower(general.basePower, general.trainingLevel);
      general.cultivationCount = clamp(Number(general.cultivationCount || 0) + 1, 0, CULTIVATION_RANGES.length);
      general.experience = 0;
      general.experienceUpdatedAt = now;
      general.talent = upgradeTalent(general.talent, job.materialId, { seed: state.seed, nonce: `${job.id}:${general.cultivationCount}` }).talent;
      appendGeneralMemory(general, {
        year: gameYear(state, now), category: "deed",
        text: `完成第${general.cultivationCount}次修炼，战力提升至${general.power}，天赋为${describeTalent(general.talent)}`,
        accountId: job.accountId, intimacyDelta: 1
      });
      effects.push({ type: "general-cultivation-complete", jobId, accountId: job.accountId, generalId: job.generalId, cultivationCount: general.cultivationCount, power: general.power, talent: clone(general.talent) });
      delete state.jobs[jobId];
      continue;
    }
    if (job.type === "power-training") {
      const player = state.players[job.accountId];
      const target = job.targetType === "player" ? player : state.generals[job.targetId];
      const targetValid = player && target && (job.targetType === "player"
        ? String(job.targetId) === String(job.accountId)
        : String(target.holderAccountId) === String(job.accountId) && target.status !== "deployed");
      if (!targetValid) {
        if (player) player.gold += Math.max(0, Number(job.cost || 0));
        effects.push({ type: "power-training-cancelled", reason: "target-unavailable", jobId, accountId: job.accountId, targetType: job.targetType, targetId: job.targetId, refundedGold: Math.max(0, Number(job.cost || 0)) });
        delete state.jobs[jobId];
        continue;
      }
      ensurePowerProgress(target, job.basePower);
      target.trainingLevel = clamp(Number(job.toLevel), target.trainingLevel, MAX_TRAINING_LEVEL);
      target.power = trainingPower(target.basePower, target.trainingLevel);
      effects.push({ type: "power-training-complete", jobId, accountId: job.accountId, targetType: job.targetType, targetId: job.targetId, levels: job.levels, trainingLevel: target.trainingLevel, power: target.power });
      delete state.jobs[jobId];
      continue;
    }
    if (job.type === "march") {
      resolveMarch(state, job, effects, now);
      delete state.jobs[jobId];
    }
  }
  return { state, effects, now };
}

function resolveMarch(state, job, effects, now) {
  const player = state.players[job.accountId];
  if (!player) return;
  const path = storedMarchPath(job.path) || pathBetween(job.from, job.to);
  grantMarchExperience(state, job, path.length, effects);
  const blocked = path.find(point => {
    const owner = dynamicCell(state, point.x, point.y).ownerAccountId;
    return owner && owner !== job.accountId;
  });
  const isTargetBlock = blocked && blocked.x === job.to.x && blocked.y === job.to.y;
  if (blocked && (!job.attack || !isTargetBlock)) {
    returnArmy(state, player, job, job.soldiers);
    player.position = { ...job.from };
    effects.push({ type: "march-blocked", jobId: job.id, accountId: job.accountId, at: blocked, returnedTo: job.from });
    return;
  }
  const targetInfo = staticCell(state.seed, job.to.x, job.to.y);
  const target = dynamicCell(state, job.to.x, job.to.y);
  const activeGeneralIds = Array.isArray(job.activeGeneralIds)
    ? job.activeGeneralIds.filter(id => job.generalIds.includes(id)).slice(0, ACTIVE_CARRIED_GENERAL_LIMIT)
    : job.generalIds.slice(0, ACTIVE_CARRIED_GENERAL_LIMIT);
  const enemy = target.ownerAccountId && target.ownerAccountId !== job.accountId;
  const neutral = !target.ownerAccountId;
  if ((enemy || neutral) && job.attack) {
    const attackModifiers = actionTalentModifiers(state, job.accountId, "combat", job.to, {
      attacking: true, armySize: job.soldiers, carriedGeneralIds: activeGeneralIds, now
    });
    const defenseModifiers = enemy ? actionTalentModifiers(state, target.ownerAccountId, "combat", job.to, {
      attacking: false, armySize: Number(target.soldiers || 0), carriedGeneralIds: [], now
    }) : null;
    const discoveryModifiers = neutral ? actionTalentModifiers(state, job.accountId, "discovery", job.to, {
      attacking: true, armySize: job.soldiers, carriedGeneralIds: activeGeneralIds, discoveryKind: "attack", now
    }) : null;
    const defenseQuote = enemy ? regionDefenseQuote(state, job.to.x, job.to.y, now) : null;
    const defenderPower = enemy ? Math.max(1, defenseQuote.power) : Math.max(1, targetInfo.neutralPower);
    const attackerGeneralPower = activeGeneralIds.reduce((sum, id) => sum + generalPower(state.generals[id]), 0);
    ensurePowerProgress(player, DEFAULT_PLAYER_BASE_POWER);
    const rawAttackerPower = job.soldiers + player.power + attackerGeneralPower;
    const attackerPower = Math.max(1, Math.round(rawAttackerPower * (1 + attackModifiers.combatPower + attackModifiers.attackPower)));
    if (enemy) {
      const defenderSoldiersBefore = Math.max(0, Math.trunc(Number(target.soldiers || 0)));
      const defenderOwnerBefore = String(target.ownerAccountId || "");
      const casualties = battleCasualties(attackerPower, defenderPower, job.soldiers, target.soldiers);
      if (!casualties.attackerWon) {
        target.soldiers = casualties.defenderSurvivors;
        returnArmy(state, player, job, casualties.attackerSurvivors);
        player.position = { ...job.from };
        effects.push({
          type: "battle-lost", jobId: job.id, accountId: job.accountId, at: job.to,
          attackerPower, defenderPower, survivors: casualties.attackerSurvivors,
          attackerSoldiers: job.soldiers, defenderSoldiers: defenderSoldiersBefore,
          targetOwnerAccountId: defenderOwnerBefore,
          attackerLosses: casualties.attackerLosses, defenderLosses: casualties.defenderLosses,
          defenderSurvivors: casualties.defenderSurvivors, attackModifiers, defenseModifiers
        });
        recordBattleReport(state, job.accountId, {
          jobId: job.id, createdAt: now, target: job.to, outcome: "defeat",
          attackerPower, defenderPower, ownLosses: casualties.attackerLosses,
          ownSurvivors: casualties.attackerSurvivors
        });
        return;
      }
      const previousOwner = target.ownerAccountId;
      const capturedGeneralIds = [...(target.generalIds || [])];
      target.ownerAccountId = job.accountId;
      target.soldiers = Math.min(targetInfo.garrisonCap, casualties.attackerSurvivors);
      target.generalIds = [];
      player.position = { ...job.to };
      rememberMarchRoute(player, job, path);
      player.fieldArmySoldiers = Math.max(0, casualties.attackerSurvivors - target.soldiers);
      for (const generalId of capturedGeneralIds) {
        const general = state.generals[generalId];
        if (!general) continue;
        const year = gameYear(state, now);
        const formerMasterAccountId = String(general.loyalToAccountId || previousOwner || general.holderAccountId || "");
        closeCurrentMaster(general, year);
        general.holderAccountId = job.accountId;
        general.capturedFromAccountId = formerMasterAccountId || null;
        general.capturedAtYear = year;
        general.status = "captured";
        general.location = { ...job.to };
        general.captivityHistory ||= [];
        general.captivityHistory.push({ captorAccountId: job.accountId, formerMasterAccountId, year });
        appendGeneralMemory(general, { year, category: "deed", text: `战败，被${playerDisplayName(state, job.accountId)}俘虏`, accountId: job.accountId, intimacyDelta: -5 });
      }
      effects.push({
        type: "battle-won", jobId: job.id, accountId: job.accountId, at: job.to, previousOwner,
        attackerPower, defenderPower, soldiers: target.soldiers, capturedGeneralIds,
        attackerSoldiers: job.soldiers, defenderSoldiers: defenderSoldiersBefore,
        targetOwnerAccountId: defenderOwnerBefore,
        attackerLosses: casualties.attackerLosses, defenderLosses: casualties.defenderLosses,
        attackerSurvivors: casualties.attackerSurvivors, defenderSurvivors: casualties.defenderSurvivors,
        attackModifiers, defenseModifiers
      });
      grantBattleExperience(state, job, activeGeneralIds, attackerPower, defenderPower, effects);
      recordBattleReport(state, job.accountId, {
        jobId: job.id, createdAt: now, target: job.to, outcome: "victory",
        attackerPower, defenderPower, soldiersGained: target.soldiers, ownLosses: casualties.attackerLosses,
        ownSurvivors: casualties.attackerSurvivors, capturedGeneralIds
      });
      claimTreasureAt(state, job.accountId, job.to, now, effects);
      return;
    }
    const neutralCasualties = battleCasualties(attackerPower, defenderPower, job.soldiers, targetInfo.neutralPower);
    if (!neutralCasualties.attackerWon) {
      returnArmy(state, player, job, neutralCasualties.attackerSurvivors);
      player.position = { ...job.from };
      effects.push({
        type: "battle-lost", jobId: job.id, accountId: job.accountId, at: job.to,
        attackerPower, defenderPower, survivors: neutralCasualties.attackerSurvivors,
        attackerSoldiers: job.soldiers, defenderSoldiers: targetInfo.neutralPower,
        attackerLosses: neutralCasualties.attackerLosses,
        defenderLosses: neutralCasualties.defenderLosses,
        defenderSurvivors: neutralCasualties.defenderSurvivors,
        attackModifiers, defenseModifiers
      });
      recordBattleReport(state, job.accountId, {
        jobId: job.id, createdAt: now, target: job.to, outcome: "defeat",
        attackerPower, defenderPower, ownLosses: neutralCasualties.attackerLosses,
        ownSurvivors: neutralCasualties.attackerSurvivors
      });
      return;
    }
    const previousOwner = target.ownerAccountId;
    const capturedGeneralIds = [...(target.generalIds || [])];
    const losses = neutralCasualties.attackerLosses;
    const survivors = neutralCasualties.attackerSurvivors;
    target.ownerAccountId = job.accountId;
    target.soldiers = Math.min(targetInfo.garrisonCap, survivors);
    target.generalIds = [];
    player.position = { ...job.to };
    rememberMarchRoute(player, job, path);
    player.fieldArmySoldiers = Math.max(0, survivors - target.soldiers);
    for (const generalId of capturedGeneralIds) {
      const general = state.generals[generalId];
      if (!general) continue;
      const year = gameYear(state, now);
      const formerMasterAccountId = String(general.loyalToAccountId || previousOwner || general.holderAccountId || "");
      closeCurrentMaster(general, year);
      general.holderAccountId = job.accountId;
      general.capturedFromAccountId = formerMasterAccountId || null;
      general.capturedAtYear = year;
      general.status = "captured";
      general.location = { ...job.to };
      general.captivityHistory ||= [];
      general.captivityHistory.push({ captorAccountId: job.accountId, formerMasterAccountId, year });
      appendGeneralMemory(general, { year, category: "deed", text: `战败，被${playerDisplayName(state, job.accountId)}俘虏`, accountId: job.accountId, intimacyDelta: -5 });
    }
    effects.push({
      type: "battle-won", jobId: job.id, accountId: job.accountId, at: job.to, previousOwner,
      attackerPower, defenderPower, soldiers: target.soldiers, capturedGeneralIds,
      attackerSoldiers: job.soldiers, defenderSoldiers: targetInfo.neutralPower,
      attackerLosses: losses, defenderLosses: neutralCasualties.defenderLosses,
      attackerSurvivors: survivors, defenderSurvivors: neutralCasualties.defenderSurvivors,
      attackModifiers, defenseModifiers
    });
    claimTreasureAt(state, job.accountId, job.to, now, effects);
    let discoveryId = null;
    if (neutral) {
      const chance = clamp(generalDiscoveryChance(targetInfo.population) + discoveryModifiers.discoveryChance, 0, 1);
      if (randomUnit(state.seed, "discover-general", state.seasonId, job.id, job.to.x, job.to.y) < chance) {
        const privatePlayer = state.privatePlayers[job.accountId] || {};
        const orientation = privatePlayer.orientation || "any";
        effects.push({
          type: "general-generation-request",
          sourceKind: "neutral-battle",
          sourceId: job.id,
          accountId: job.accountId,
          x: job.to.x,
          y: job.to.y,
          gender: allowedGeneralGender(orientation, state.seed, job.id),
          directionTags: selectGeneralDirectionTags(privatePlayer, state.seed, state.seasonId, job.id, job.to.x, job.to.y),
          initial: false,
          population: targetInfo.population,
          resourceGrade: targetInfo.resourceGrade,
          createdAt: now
        });
        const candidate = effects[effects.length - 1];
        candidate.discoveryId = `neutral-battle:${job.id}`;
        discoveryId = candidate.discoveryId;
        queueGeneralDiscovery(state, candidate);
      }
    }
    grantBattleExperience(state, job, activeGeneralIds, attackerPower, defenderPower, effects);
    recordBattleReport(state, job.accountId, {
      jobId: job.id, createdAt: now, target: job.to, outcome: "victory",
      attackerPower, defenderPower, soldiersGained: target.soldiers, ownLosses: losses, ownSurvivors: survivors,
      capturedGeneralIds, discoveryId
    });
    return;
  }
  player.position = { ...job.to };
  rememberMarchRoute(player, job, path);
  player.fieldArmySoldiers = Math.max(0, Math.trunc(Number(player.fieldArmySoldiers) || 0))
    + Math.max(0, Math.trunc(Number(job.soldiers) || 0));
  effects.push({ type: "march-arrived", jobId: job.id, accountId: job.accountId, at: job.to, fieldArmySoldiers: player.fieldArmySoldiers });
}

function ensurePlayer(state, accountId) {
  const player = state.players[accountId];
  if (!player) throw new Error("玩家尚未加入本赛季");
  return player;
}

function pendingGeneralDiscoveries(state, accountId) {
  state.privatePlayers ||= {};
  const privatePlayer = state.privatePlayers[String(accountId)] ||= {};
  if (!Array.isArray(privatePlayer.pendingGeneralDiscoveries)) privatePlayer.pendingGeneralDiscoveries = [];
  return privatePlayer.pendingGeneralDiscoveries;
}

function queueGeneralDiscovery(state, effect) {
  const list = pendingGeneralDiscoveries(state, effect.accountId);
  const id = String(effect.discoveryId || `${effect.sourceKind || "discovery"}:${effect.sourceId}`);
  if (list.some(item => String(item.id) === id)) return id;
  list.push({
    id,
    sourceKind: String(effect.sourceKind || "neutral-battle"),
    sourceId: String(effect.sourceId || id),
    accountId: String(effect.accountId),
    x: Math.trunc(Number(effect.x) || 0),
    y: Math.trunc(Number(effect.y) || 0),
    gender: effect.gender === "male" ? "male" : "female",
    directionTags: normalizedCharacterTags(effect.directionTags),
    initial: Boolean(effect.initial),
    population: Number(effect.population || 0),
    resourceGrade: String(effect.resourceGrade || ""),
    trainedSoldiers: Math.max(0, Math.trunc(Number(effect.trainedSoldiers || 0))),
    createdAt: Number(effect.createdAt || 0)
  });
  return id;
}

function removePendingGeneralDiscovery(state, accountId, discoveryId) {
  const list = pendingGeneralDiscoveries(state, accountId);
  const index = list.findIndex(item => String(item.id) === String(discoveryId));
  if (index < 0) return null;
  return list.splice(index, 1)[0];
}

function jobFor(state, predicate) {
  return Object.values(state.jobs).find(predicate);
}

function applyIntent(inputState, rawIntent, context = {}) {
  const now = Number(context.now ?? Date.now());
  const actorAccountId = String(context.actorAccountId || rawIntent?.actorAccountId || "").trim();
  if (!actorAccountId) throw new Error("缺少玩家账号");
  const intent = clone(rawIntent || {});
  const type = String(intent.type || "");
  inputState.bans ||= {};
  inputState.playerEpochs ||= {};
  if (inputState.bans[actorAccountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁");
  const idempotencyKey = String(intent.idempotencyKey || context.eventId || crypto.randomUUID()).slice(0, 100);
  if (inputState.processedIntents.includes(idempotencyKey)) return { state: clone(inputState), duplicate: true, effects: [], event: null };
  const settled = settleWorld(inputState, now, { activeAccountId: actorAccountId, experienceSince: context.experienceSince });
  const state = settled.state;
  state.marketListings ||= {};
  state.marketSales ||= {};
  const effects = [...settled.effects];
  let result = {};

  if (type === "join") {
    if (state.players[actorAccountId]) throw new Error("玩家已经加入本赛季");
    const orientation = ORIENTATIONS.has(intent.orientation) ? intent.orientation : null;
    if (!orientation) throw new Error("请选择将领性别偏好");
    const characterProfileId = String(intent.characterProfileId || "").trim().slice(0, 100);
    if (!characterProfileId) throw new Error("请选择绑定的角色设定");
    const characterTags = normalizedCharacterTags(intent.characterTags);
    if (characterTags.length < 1) throw new Error("请至少添加一个性癖标签");
    const initialGeneralWish = String(intent.initialGeneralWish || "").trim().slice(0, 500);
    if (!initialGeneralWish) throw new Error("请描述开疆扩土前想遇到的良将");
    const capital = chooseCapital(state, actorAccountId);
    const info = staticCell(state.seed, capital.x, capital.y);
    const cell = dynamicCell(state, capital.x, capital.y);
    cell.ownerAccountId = actorAccountId;
    cell.soldiers = Math.max(1, Math.floor(info.garrisonCap * 0.5));
    state.players[actorAccountId] = {
      accountId: actorAccountId,
      accountName: String(context.actorAccountName || intent.accountName || actorAccountId).slice(0, 80),
      displayName: String(intent.displayName || actorAccountId).slice(0, 40),
      gold: STARTING_PLAYER_GOLD,
      basePower: DEFAULT_PLAYER_BASE_POWER,
      trainingLevel: 0,
      cultivationCount: 0,
      power: DEFAULT_PLAYER_BASE_POWER,
      position: capital,
      fieldArmySoldiers: 0,
      carriedGeneralIds: [],
      joinedAt: now
    };
    state.privatePlayers[actorAccountId] = {
      orientation,
      characterProfileId,
      characterTags,
      initialGeneralWish,
      playerContext: intent.playerContext && typeof intent.playerContext === "object" ? clone(intent.playerContext) : null,
      initialGeneralGranted: false,
      materials: Object.fromEntries(MATERIAL_IDS.map(id => [id, 0]))
    };
    effects.push({
      type: "general-generation-request",
      sourceId: idempotencyKey,
      accountId: actorAccountId,
      x: capital.x,
      y: capital.y,
      gender: allowedGeneralGender(orientation, state.seed, "initial", actorAccountId),
      directionTags: [],
      initialWish: initialGeneralWish,
      initial: true,
      population: info.population,
      resourceGrade: info.resourceGrade
    });
    result = { capital, gold: STARTING_PLAYER_GOLD, power: DEFAULT_PLAYER_BASE_POWER, soldiers: cell.soldiers };
  } else {
    const player = ensurePlayer(state, actorAccountId);
    if (type === "dismiss-battle-report") {
      const reportId = String(intent.reportId || "").trim();
      if (!reportId) throw new Error("缺少战报编号");
      const reports = battleReportsFor(state, actorAccountId);
      const index = reports.findIndex(item => String(item?.id || "") === reportId);
      if (index < 0) throw new Error("这份战报已经处理或不存在");
      reports.splice(index, 1);
      result = { reportId, dismissed: true };
    } else if (type === "confirm-general-discovery" || type === "decline-general-discovery") {
      const discoveryId = String(intent.discoveryId || "").trim();
      if (!discoveryId) throw new Error("缺少待提拔将领编号");
      const candidate = (state.privatePlayers?.[actorAccountId]?.pendingGeneralDiscoveries || [])
        .find(item => String(item.id) === discoveryId);
      if (!candidate) throw new Error("这项发掘已经处理或不存在");
      const removed = removePendingGeneralDiscovery(state, actorAccountId, discoveryId);
      if (type === "confirm-general-discovery") {
        effects.push({
          type: "general-generation-request",
          sourceKind: removed.sourceKind,
          sourceId: removed.sourceId,
          discoveryId: removed.id,
          accountId: actorAccountId,
          x: removed.x,
          y: removed.y,
          gender: removed.gender,
          directionTags: removed.directionTags,
          initial: false,
          population: removed.population,
          resourceGrade: removed.resourceGrade,
          trainedSoldiers: removed.trainedSoldiers,
          confirmed: true
        });
        result = { generalDiscoveryConfirmed: true, discoveryId: removed.id };
      } else {
        result = { generalDiscoveryDeclined: true, discoveryId: removed.id };
      }
    } else if (type === "start-mining") {
      const x = coordinate(intent.x, "横坐标");
      const y = coordinate(intent.y, "纵坐标");
      const cell = dynamicCell(state, x, y);
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能开采自己占领的区域");
      if (jobFor(state, job => job.type === "mining" && job.accountId === actorAccountId && job.x === x && job.y === y)) throw new Error("该区域已经在开采");
      if (jobFor(state, job => job.type === "training" && job.accountId === actorAccountId && job.x === x && job.y === y)) throw new Error("该区域正在练兵");
      const activeMiningJobs = Object.values(state.jobs).filter(job => job.type === "mining" && job.accountId === actorAccountId).length;
      if (activeMiningJobs >= MAX_CONCURRENT_MINING_JOBS) throw new Error(`最多同时开采 ${MAX_CONCURRENT_MINING_JOBS} 块领地`);
      const info = staticCell(state.seed, x, y);
      const cooldowns = miningCooldownsFor(state, actorAccountId);
      const availableAt = Math.max(0, Number(cooldowns[keyOf(x, y)] || 0));
      if (availableAt > now) throw new Error("该区域开采冷却尚未结束");
      delete cooldowns[keyOf(x, y)];
      const modifiers = actionTalentModifiers(state, actorAccountId, "mining", { x, y }, { now });
      const cycleMs = resourceCycleMs(info);
      const yieldPerCycle = roundByModifier(resourceYield(info), modifiers.miningYield, 1);
      const id = crypto.randomUUID();
      state.jobs[id] = { id, type: "mining", accountId: actorAccountId, x, y, auto: false, startedAt: now, finishAt: now + cycleMs, lastSettledAt: now, cycleMs, yieldPerCycle, yieldFormulaVersion: RESOURCE_YIELD_FORMULA_VERSION, modifiers };
      result = { jobId: id, cycleMs, durationMs: cycleMs, finishAt: state.jobs[id].finishAt, yieldPerCycle, auto: false, modifiers };
    } else if (type === "stop-mining") {
      const id = String(intent.jobId || "");
      const job = state.jobs[id];
      if (!job || job.type !== "mining" || job.accountId !== actorAccountId) throw new Error("找不到这项开采任务");
      delete state.jobs[id];
      result = { jobId: id, stopped: true };
    } else if (type === "train") {
      const x = coordinate(intent.x, "横坐标");
      const y = coordinate(intent.y, "纵坐标");
      const requestedAmount = integer(intent.amount ?? (String(intent.mode || "").toLowerCase() === "max" ? 1 : 0), "练兵数量", 1, 10000);
      const cell = dynamicCell(state, x, y);
      const info = staticCell(state.seed, x, y);
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能在自己占领的区域练兵");
      if (jobFor(state, job => job.type === "training" && job.accountId === actorAccountId && job.x === x && job.y === y)) throw new Error("同一格内只能同时进行一项练兵");
      if (jobFor(state, job => job.type === "mining" && job.accountId === actorAccountId && job.x === x && job.y === y)) throw new Error("该区域正在开采");
      const modifiers = actionTalentModifiers(state, actorAccountId, "training", { x, y }, { armySize: requestedAmount, now });
      const remainingGarrison = Math.max(0, info.garrisonCap - Number(cell.soldiers || 0));
      const amount = String(intent.mode || "").toLowerCase() === "max"
        ? maxTrainingInputForRemaining(remainingGarrison, modifiers.trainingYield)
        : requestedAmount;
      if (amount < 1) throw new Error(`该区域驻军上限为 ${info.garrisonCap}`);
      const effectiveModifiers = actionTalentModifiers(state, actorAccountId, "training", { x, y }, { armySize: amount, now });
      const outputAmount = roundByModifier(amount, effectiveModifiers.trainingYield, 1);
      if (cell.soldiers + outputAmount > info.garrisonCap) throw new Error(`该区域驻军上限为 ${info.garrisonCap}`);
      const cost = roundByModifier(amount * 2, effectiveModifiers.trainingCost, 1);
      const durationMs = roundByModifier(trainDurationMs(amount), effectiveModifiers.trainingDuration, 1000);
      if (player.gold < cost) throw new Error("金币不足");
      player.gold -= cost;
      const id = crypto.randomUUID();
      state.jobs[id] = { id, type: "training", accountId: actorAccountId, x, y, amount, outputAmount, cost, startedAt: now, finishAt: now + durationMs, modifiers: effectiveModifiers };
      result = { jobId: id, amount, outputAmount, cost, durationMs, finishAt: state.jobs[id].finishAt, modifiers: effectiveModifiers };
    } else if (type === "cultivate-player") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能闭关修炼");
      if (jobFor(state, job => job.type === "power-training" && job.accountId === actorAccountId && job.targetType === "player")) throw new Error("已有旧版修炼任务正在进行");
      const quote = playerCultivationActionQuote(state, actorAccountId, intent.goldInvestment, now);
      if (player.gold < quote.cost) throw new Error("金币不足");
      player.gold -= quote.cost;
      ensurePowerProgress(player, DEFAULT_PLAYER_BASE_POWER);
      player.basePower = clamp(player.basePower + quote.basePowerGain, 1, 100000);
      player.power = trainingPower(player.basePower, player.trainingLevel);
      player.cultivationCount = clamp(Number(player.cultivationCount || 0) + 1, 0, CULTIVATION_RANGES.length);
      effects.push({ type: "player-cultivation-complete", accountId: actorAccountId, cultivationCount: player.cultivationCount, power: player.power });
      result = { targetType: "player", targetId: actorAccountId, ...quote, durationMs: 0, cultivationCount: player.cultivationCount, power: player.power };
    } else if (type === "power-train") {
      const targetType = intent.targetType === "general" ? "general" : "player";
      if (targetType === "general") throw new Error("将领战力只能通过五次天赋修炼提升");
      const targetId = targetType === "player" ? actorAccountId : String(intent.targetId || "");
      const target = targetType === "player" ? player : state.generals[targetId];
      if (!target || (targetType === "general" && (target.holderAccountId !== actorAccountId || ["deployed", "market", "captured"].includes(target.status)))) throw new Error("只有自己和未部署的自有将领可以修炼");
      if (jobFor(state, job => job.type === "power-training" && job.accountId === actorAccountId && job.targetType === targetType && job.targetId === targetId)) throw new Error("该角色已经在修炼");
      if (targetType === "general" && jobFor(state, job => job.type === "general-cultivation" && job.accountId === actorAccountId && job.generalId === targetId)) throw new Error("该将领正在天赋修炼");
      const march = jobFor(state, job => job.type === "march" && job.accountId === actorAccountId);
      if (march && (targetType === "player" || march.generalIds.includes(targetId))) throw new Error("行军途中不能开始修炼");
      const quote = powerTrainingQuote(target, intent.levels);
      if (player.gold < quote.cost) throw new Error("金币不足");
      player.gold -= quote.cost;
      const id = crypto.randomUUID();
      state.jobs[id] = {
        id, type: "power-training", accountId: actorAccountId, targetType, targetId,
        targetName: targetType === "player" ? player.displayName : target.name,
        levels: quote.levels, fromLevel: quote.fromLevel, toLevel: quote.toLevel,
        basePower: target.basePower, cost: quote.cost, startedAt: now, finishAt: now + quote.durationMs
      };
      result = { jobId: id, targetType, targetId, cost: quote.cost, levels: quote.levels, fromLevel: quote.fromLevel, toLevel: quote.toLevel, currentPower: quote.currentPower, nextPower: quote.nextPower, finishAt: state.jobs[id].finishAt };
    } else if (type === "cultivate-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || String(general.holderAccountId) !== actorAccountId || ["market", "captured"].includes(general.status)) throw new Error("只能修炼未上架的自己的将领");
      if (jobFor(state, job => job.type === "general-cultivation" && job.accountId === actorAccountId && job.generalId === generalId)) throw new Error("该将领已经在修炼");
      if (jobFor(state, job => job.type === "power-training" && job.accountId === actorAccountId && job.targetType === "general" && job.targetId === generalId)) throw new Error("该将领正在旧版修炼任务中");
      const march = jobFor(state, job => job.type === "march" && job.accountId === actorAccountId);
      if (march && march.generalIds.includes(generalId)) throw new Error("行军途中不能修炼将领");
      const quote = cultivationActionQuote(state, actorAccountId, generalId, intent.goldInvestment, intent.materialId, now);
      const privatePlayer = state.privatePlayers[actorAccountId] ||= { orientation: "any" };
      const materials = ensureMaterialInventory(privatePlayer);
      if (Number(materials[quote.materialId] || 0) < 1) throw new Error("所选天赋素材不足");
      if (player.gold < quote.cost) throw new Error("金币不足");
      player.gold -= quote.cost;
      materials[quote.materialId] -= 1;
      ensurePowerProgress(general);
      general.basePower = clamp(general.basePower + quote.basePowerGain, 1, 100000);
      general.power = trainingPower(general.basePower, general.trainingLevel);
      general.cultivationCount += 1;
      general.experience = 0;
      general.experienceUpdatedAt = now;
      general.talent = upgradeTalent(general.talent, quote.materialId, { seed: state.seed, nonce: `${idempotencyKey}:${general.cultivationCount}` }).talent;
      appendGeneralMemory(general, {
        year: gameYear(state, now), category: "deed",
        text: `完成第${general.cultivationCount}次修炼，战力提升至${general.power}，天赋为${describeTalent(general.talent)}`,
        accountId: actorAccountId, intimacyDelta: 1
      });
      effects.push({ type: "general-cultivation-complete", accountId: actorAccountId, generalId, cultivationCount: general.cultivationCount, power: general.power, talent: clone(general.talent) });
      result = { generalId, ...quote, durationMs: 0, cultivationCount: general.cultivationCount, power: general.power, talent: clone(general.talent) };
    } else if (type === "reorder-carried-generals") {
      const requested = Array.isArray(intent.generalIds) ? [...new Set(intent.generalIds.map(String))] : [];
      const current = [...new Set((player.carriedGeneralIds || []).map(String))];
      const currentSet = new Set(current);
      if (requested.length !== current.length || requested.some(id => !currentSet.has(id))) throw new Error("随行将领顺序必须包含当前全部将领");
      player.carriedGeneralIds = requested;
      result = { generalIds: [...requested], activeGeneralIds: requested.slice(0, ACTIVE_CARRIED_GENERAL_LIMIT) };
    } else if (type === "list-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      const price = integer(intent.price, "售价", 1, 1000000000);
      if (!general || String(general.holderAccountId) !== actorAccountId) throw new Error("只能上架自己的将领");
      if (general.status === "captured" || general.status === "deployed" || general.status === "market") throw new Error("当前将领不能上架名将市场");
      if (general.marketListingId) throw new Error("这名将领已经在名将市场中");
      const relistAvailableAt = Math.max(0, Number(general.marketRelistAvailableAt || 0));
      if (relistAvailableAt > now) throw new Error(`这名将领下架后需要等待 ${Math.ceil((relistAvailableAt - now) / HOUR)} 小时才能再次售卖`);
      const listingId = String(intent.listingId || crypto.randomUUID()).slice(0, 64);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(listingId) || state.marketListings[listingId]) throw new Error("名将市场编号无效");
      const sourceStatus = ["carried", "waiting"].includes(String(general.status)) ? String(general.status) : "carried";
      const sellerIntro = String(intent.sellerIntro || "").replace(/\s+/g, " ").trim().slice(0, 240);
      general.status = "market";
      general.marketListingId = listingId;
      general.marketRelistAvailableAt = 0;
      player.carriedGeneralIds = (player.carriedGeneralIds || []).filter(id => String(id) !== generalId);
      state.marketListings[listingId] = {
        listingId,
        sellerAccountId: actorAccountId,
        sellerDisplayName: String(player.displayName || actorAccountId).slice(0, 40),
        generalId,
        sourceStatus,
        price,
        listedAt: now,
        sellerIntro,
        general: publicMarketGeneralState(general)
      };
      result = { listingId, generalId, price, sellerIntro, listed: true };
    } else if (type === "cancel-market-listing") {
      const listingId = String(intent.listingId || "");
      const listing = state.marketListings[listingId];
      const general = listing ? state.generals[listing.generalId] : null;
      if (!listing || String(listing.sellerAccountId) !== actorAccountId || !general || String(general.holderAccountId) !== actorAccountId) throw new Error("找不到可撤下的名将市场商品");
      delete state.marketListings[listingId];
      general.marketListingId = null;
      general.status = "carried";
      general.marketRelistAvailableAt = now + MARKET_RELIST_COOLDOWN_MS;
      if (!player.carriedGeneralIds.includes(general.id)) player.carriedGeneralIds.push(general.id);
      result = { listingId, generalId: general.id, cancelled: true, relistAvailableAt: general.marketRelistAvailableAt };
    } else if (type === "buy-market-general") {
      const listingId = String(intent.listingId || "");
      const listing = state.marketListings[listingId];
      if (!listing) throw new Error("这件名将已经售出或下架");
      if (String(listing.sellerAccountId) === actorAccountId) throw new Error("不能购买自己上架的将领");
      const price = integer(listing.price, "售价", 1, 1000000000);
      if (player.gold < price) throw new Error("金币不足");
      const source = listing.general && typeof listing.general === "object" ? clone(listing.general) : null;
      if (!source?.id || source.id !== listing.generalId) throw new Error("名将市场商品资料无效");
      player.gold -= price;
      const general = {
        ...source,
        id: source.id,
        holderAccountId: actorAccountId,
        status: "carried",
        location: null,
        marketListingId: null,
        loyalToAccountId: actorAccountId,
        masterHistory: [...(Array.isArray(source.masterHistory) ? source.masterHistory : []), { accountId: actorAccountId, fromYear: gameYear(state, now), toYear: null, reason: "市场购入" }]
      };
      ensureGeneralProfile(general);
      state.generals[general.id] = general;
      if (!player.carriedGeneralIds.includes(general.id)) player.carriedGeneralIds.push(general.id);
      delete state.marketListings[listingId];
      const transactionId = String(intent.transactionId || crypto.randomUUID()).slice(0, 64);
      state.marketSales[transactionId] = {
        transactionId,
        listingId,
        generalId: general.id,
        sellerAccountId: String(listing.sellerAccountId),
        buyerAccountId: actorAccountId,
        price,
        general: source,
        soldAt: now
      };
      result = { listingId, transactionId, generalId: general.id, price, purchased: true };
    } else if (type === "cancel-march") {
      const jobId = String(intent.jobId || "");
      const job = state.jobs[jobId];
      if (!job || job.type !== "march" || String(job.accountId) !== actorAccountId) throw new Error("找不到正在进行的行程");
      const player = ensurePlayer(state, actorAccountId);
      player.fieldArmySoldiers = Math.max(0, Math.trunc(Number(player.fieldArmySoldiers) || 0))
        + Math.max(0, Math.trunc(Number(job.soldiers) || 0));
      player.position = { ...job.from };
      delete state.jobs[jobId];
      result = { jobId, cancelled: true, returnedSoldiers: Math.max(0, Math.trunc(Number(job.soldiers) || 0)), refundedGold: 0 };
    } else if (type === "deploy-soldiers" || type === "gather-march") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能调度驻军");
      const position = { x: coordinate(player.position?.x, "玩家所在地横坐标"), y: coordinate(player.position?.y, "玩家所在地纵坐标") };
      const cell = dynamicCell(state, position.x, position.y);
      const info = staticCell(state.seed, position.x, position.y);
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能在自己的领地调度驻军");
      const deploying = type === "deploy-soldiers";
      const available = deploying ? Math.max(0, Math.trunc(Number(player.fieldArmySoldiers) || 0)) : Math.max(0, Math.trunc(Number(cell.soldiers) || 0));
      const capacity = deploying ? Math.max(0, info.garrisonCap - Math.trunc(Number(cell.soldiers) || 0)) : available;
      const requested = String(intent.mode || "").toLowerCase() === "max"
        ? Math.min(available, capacity)
        : integer(intent.amount ?? intent.delta ?? 0, "调度士兵数量", 0, 1000000);
      const amount = Math.min(requested, available, capacity);
      if (amount <= 0) throw new Error(deploying ? "没有可部署的士兵" : "领地中没有可征集的士兵");
      if (deploying) {
        player.fieldArmySoldiers = available - amount;
        cell.soldiers = Math.trunc(Number(cell.soldiers) || 0) + amount;
      } else {
        cell.soldiers = Math.trunc(Number(cell.soldiers) || 0) - amount;
        player.fieldArmySoldiers = Math.trunc(Number(player.fieldArmySoldiers) || 0) + amount;
      }
      result = { type, x: position.x, y: position.y, amount, fieldArmySoldiers: player.fieldArmySoldiers, garrison: cell.soldiers, garrisonCap: info.garrisonCap };
    } else if (type === "march") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("已有行军正在途中");
      if (jobFor(state, job => job.type === "power-training" && job.accountId === actorAccountId && job.targetType === "player")) throw new Error("自身修炼期间不能行军");
      const to = { x: coordinate(intent.to?.x, "目标横坐标"), y: coordinate(intent.to?.y, "目标纵坐标") };
      const from = {
        x: coordinate(player.position?.x, "玩家所在地横坐标"),
        y: coordinate(player.position?.y, "玩家所在地纵坐标")
      };
      const requested = integer(intent.soldiers ?? 0, "携带士兵", 0, 1000000);
      const generalIds = [...new Set((player.carriedGeneralIds || []).map(String))];
      const activeGeneralIds = generalIds.slice(0, ACTIVE_CARRIED_GENERAL_LIMIT);
      if (jobFor(state, job => job.type === "power-training" && job.accountId === actorAccountId && job.targetType === "general" && generalIds.includes(job.targetId))) throw new Error("正在修炼的将领不能随军出征");
      if (jobFor(state, job => job.type === "general-cultivation" && job.accountId === actorAccountId && generalIds.includes(job.generalId))) throw new Error("正在修炼的将领不能随军出征");
      const available = Math.max(0, Math.trunc(Number(player.fieldArmySoldiers) || 0));
      if (requested > available) throw new Error("行军队伍士兵不足，请先确认征集");
      const quote = marchQuote(state, actorAccountId, to, requested, generalIds, Boolean(intent.attack), now);
      const path = quote.path;
      const cost = quote.cost;
      if (player.gold < cost) throw new Error("金币不足");
      battleReportsFor(state, actorAccountId).splice(0);
      player.fieldArmySoldiers = available - requested;
      player.gold -= cost;
      const id = crypto.randomUUID();
      const marchJob = { id, type: "march", accountId: actorAccountId, from, to, path, soldiers: requested, generalIds, activeGeneralIds, attack: Boolean(intent.attack), cost, startedAt: now, finishAt: now + quote.durationMs, modifiers: quote.modifiers };
      if (!path.length) {
        resolveMarch(state, marchJob, effects, now);
        result = { jobId: id, cost, distance: 0, durationMs: 0, finishAt: now, activeGeneralIds, modifiers: quote.modifiers, resolved: true };
      } else {
        state.jobs[id] = marchJob;
        result = { jobId: id, cost, distance: path.length, durationMs: quote.durationMs, finishAt: state.jobs[id].finishAt, activeGeneralIds, modifiers: quote.modifiers };
      }
    } else if (type === "deploy-general") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能部署将领");
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      const { x, y } = player.position;
      const cell = dynamicCell(state, x, y);
      if (!general || general.holderAccountId !== actorAccountId || general.status === "market" || !player.carriedGeneralIds.includes(generalId)) throw new Error("将领不在身边");
      if (jobFor(state, job => job.type === "power-training" && job.accountId === actorAccountId && job.targetType === "general" && job.targetId === generalId)) throw new Error("正在修炼的将领不能部署");
      if (jobFor(state, job => job.type === "general-cultivation" && job.accountId === actorAccountId && job.generalId === generalId)) throw new Error("正在修炼的将领不能部署");
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能在自己的区域部署将领");
      if (cell.generalIds.length >= 2) throw new Error("每个区域最多部署两名将领");
      player.carriedGeneralIds = player.carriedGeneralIds.filter(id => id !== generalId);
      cell.generalIds.push(generalId);
      general.status = "deployed";
      general.location = { x, y };
      general.experienceUpdatedAt = now;
      result = { generalId, x, y, publishGeneralArchive: true };
    } else if (type === "recall-general") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能召回将领");
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      const { x, y } = player.position;
      const cell = dynamicCell(state, x, y);
      if (!general || general.holderAccountId !== actorAccountId || !cell.generalIds.includes(generalId)) throw new Error("该区域没有这名将领");
      cell.generalIds = cell.generalIds.filter(id => id !== generalId);
      if (!player.carriedGeneralIds.includes(generalId)) player.carriedGeneralIds.push(generalId);
      general.status = "carried";
      general.location = null;
      general.experienceUpdatedAt = now;
      result = { generalId, removeGeneralWorldBook: false };
    } else if (type === "take-general") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能带走留置将领");
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || general.holderAccountId !== actorAccountId || general.status !== "waiting") throw new Error("这里没有可带走的将领");
      if (general.location?.x !== player.position.x || general.location?.y !== player.position.y) throw new Error("必须到达将领所在区域才能带走");
      if (!player.carriedGeneralIds.includes(generalId)) player.carriedGeneralIds.push(generalId);
      general.status = "carried";
      general.location = null;
      result = { generalId };
    } else if (type === "talk-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!canInteractWithGeneral(state, player, general)) throw new Error("只能与身边、俘虏区或当前位置的自家部署将领交谈");
      const topic = String(intent.topic || "").trim().slice(0, 120);
      if (!topic) throw new Error("请输入谈话内容");
      const battleReportId = String(intent.battleReportId || "").trim();
      const battleReport = battleReportId
        ? battleReportsFor(state, actorAccountId).find(item => String(item?.id || "") === battleReportId)
        : null;
      if (battleReportId && !battleReport) throw new Error("这份战报已经失效，请重新选择话题");
      const privatePlayer = state.privatePlayers[actorAccountId] ||= { orientation: "any" };
      privatePlayer.lastDialogueAtByGeneral ||= {};
      const lastDialogueAt = Number(privatePlayer.lastDialogueAtByGeneral[generalId] || 0);
      if (lastDialogueAt && now - lastDialogueAt < DIALOGUE_COOLDOWN_MS) throw new Error("将领对话请求过于频繁，请稍后再试");
      privatePlayer.lastDialogueAtByGeneral[generalId] = now;
      result = { generalId, topic, battleReportId: battleReport?.id || null, modelRequest: buildGeneralDialogueRequest(state, general, player, topic, now, battleReport) };
    } else if (type === "record-general-dialogue") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!canInteractWithGeneral(state, player, general)) throw new Error("当前不可与这名将领交谈");
      const memoryUpdate = intent.memoryUpdate && typeof intent.memoryUpdate === "object" ? intent.memoryUpdate : {};
      const category = memoryUpdate.category === "deed" ? "deed" : "speech";
      const summary = String(memoryUpdate.summary || `和${player.displayName}谈论${String(intent.topic || "日常").slice(0, 40)}`).trim().slice(0, 120);
      const emotion = String(memoryUpdate.emotion || "").trim().slice(0, 40);
      appendGeneralMemory(general, { year: gameYear(state, now), category, text: emotion ? `${summary}（${emotion}）` : summary, accountId: actorAccountId, intimacyDelta: clamp(Number(memoryUpdate.intimacyDelta ?? intent.intimacyDelta ?? 1), -5, 5) });
      const compactMemory = String(memoryUpdate.compactMemory || "").trim();
      if (compactMemory) general.memoryText = compactMemory.slice(0, 1000);
      const narration = String(intent.narration || "").trim().slice(0, 600);
      general.interactionHistory ||= [];
      general.interactionHistory.push({
        year: gameYear(state, now),
        accountId: actorAccountId,
        speakerName: player.displayName,
        kind: general.status === "captured" ? "captive" : "ordinary",
        category,
        summary,
        emotion,
        userText: String(intent.userText || "").slice(0, 240),
        reply: String(intent.reply || "").slice(0, 600),
        ...(narration ? { narration } : {})
      });
      // 保留本地完整互动记录，书信与外观变更模型需要读取全部经历。
      if (general.interactionHistory.length > 1000) general.interactionHistory.splice(0, general.interactionHistory.length - 1000);
      result = { generalId, memoryText: general.memoryText, intimacy: general.memory.intimacy[actorAccountId] };
    } else if (type === "surrender-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || general.holderAccountId !== actorAccountId || general.status !== "captured") throw new Error("这名将领当前不在俘虏区");
      const year = gameYear(state, now);
      const formerMaster = [...(general.masterHistory || [])].reverse().find(item => String(item.accountId || "") !== String(actorAccountId));
      general.loyalToAccountId = actorAccountId;
      general.masterHistory ||= [];
      general.masterHistory.push({ accountId: actorAccountId, fromYear: year, toYear: null, reason: "降服" });
      appendGeneralMemory(general, { year, category: "deed", text: `向${player.displayName || "某位主公"}降服并奉其为主公`, accountId: actorAccountId, intimacyDelta: 8 });
      if (!player.carriedGeneralIds.includes(generalId)) player.carriedGeneralIds.push(generalId);
      general.status = "carried";
      general.location = null;
      result = {
        generalId,
        status: general.status,
        surrendered: true,
        letterProposal: formerMaster ? {
          recipientAccountId: String(formerMaster.accountId),
          recipientName: playerDisplayName(state, formerMaster.accountId),
          purpose: "向前任主公说明归顺决定与今后的去向",
          kind: "surrender"
        } : null
      };
    } else if (type === "execute-captive") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || general.holderAccountId !== actorAccountId || general.status !== "captured") throw new Error("这名将领当前不在俘虏区");
      const allowFarewell = Boolean(intent.allowFarewell);
      if (allowFarewell) {
        const formerLords = formerLordRouting(state, general, actorAccountId);
        if (!formerLords.length) throw new Error("这名俘虏没有可联系的旧主");
        result = {
          generalId,
          farewellRequest: buildGeneralLetterRequest(state, general, player, {
            kind: "farewell",
            purpose: "诀别前向自己最想道别的旧主留下最后一封信",
            allowedRecipients: formerLords,
            guidance: String(intent.guidance || "").trim().slice(0, 500)
          }, now)
        };
      } else {
        delete state.generals[generalId];
        player.carriedGeneralIds = (player.carriedGeneralIds || []).filter(id => id !== generalId);
        result = { generalId, executed: true, farewellRequest: null };
      }
    } else if (type === "edit-general-appearance") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!canInteractWithGeneral(state, player, general)) throw new Error("当前不可修改这名将领的外观");
      const note = String(intent.note || "").trim().slice(0, 1000);
      if (!note) throw new Error("请说明希望变更的外观");
      result = { generalId, modelRequest: buildGeneralAppearanceRequest(state, general, player, note, now) };
    } else if (type === "apply-general-appearance") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!canInteractWithGeneral(state, player, general)) throw new Error("当前不可修改这名将领的外观");
      const appearanceSetting = String(intent.appearanceSetting || "").trim().slice(0, 350);
      if (!appearanceSetting) throw new Error("外观设定不能为空");
      general.appearanceSetting = appearanceSetting;
      ensureGeneralProfile(general);
      result = { generalId, appearanceSetting: general.appearanceSetting };
    } else if (type === "grant-general") {
      if (String(context.authorityAccountId || "") !== String(state.authorityAccountId || actorAccountId)) throw new Error("只有本局权威端可以登记新将领");
      const gender = intent.gender === "female" ? "female" : "male";
      const expected = allowedGeneralGender(state.privatePlayers[actorAccountId]?.orientation || "any", state.seed, intent.discoveryId || idempotencyKey);
      if (gender !== expected && state.privatePlayers[actorAccountId]?.orientation !== "any") throw new Error("将领性别不符合玩家开局偏好");
      const power = intent.generated || intent.initial
        ? generatedGeneralPower(state.seed, actorAccountId, intent.powerSeed || intent.discoveryId || idempotencyKey)
        : intent.power;
      const general = createFallbackGeneral({
        id: intent.generalId, name: intent.name, gender,
        heightCm: intent.heightCm, weightKg: intent.weightKg, measurements: intent.measurements,
        appearanceSetting: intent.appearanceSetting, coreSetting: intent.coreSetting, setting: intent.setting,
        power, holderAccountId: actorAccountId, holderName: player.displayName, year: gameYear(state, now), talentSeed: state.seed
      });
      state.generals[general.id] = general;
      if (!player.carriedGeneralIds.includes(general.id)) player.carriedGeneralIds.push(general.id);
      if (intent.initial && state.privatePlayers[actorAccountId]) state.privatePlayers[actorAccountId].initialGeneralGranted = true;
      if (intent.discoveryId) {
        for (const report of battleReportsFor(state, actorAccountId)) {
          if (String(report.discoveryId || "") !== String(intent.discoveryId)) continue;
          report.discoveredGeneralId = general.id;
          report.discoveredGeneralName = general.name;
        }
      }
      result = { generalId: general.id, name: general.name, status: general.status, location: general.location };
    } else throw new Error(`未知游戏行动：${type}`);
  }

  state.revision += 1;
  state.processedIntents.push(idempotencyKey);
  if (state.processedIntents.length > 1000) state.processedIntents.splice(0, state.processedIntents.length - 1000);
  const publicIntent = { ...intent, actorAccountId };
  delete publicIntent.orientation;
  delete publicIntent.characterTags;
  delete publicIntent.initialGeneralWish;
  delete publicIntent.characterProfileId;
  delete publicIntent.characterProfile;
  delete publicIntent.playerContext;
  delete publicIntent.memoryUpdate;
  const event = { schema: "fyow.event/3", eventId: String(context.eventId || crypto.randomUUID()), gameId: state.gameId, seasonId: state.seasonId, revision: state.revision, actorAccountId, type, intent: publicIntent, result, createdAt: now };
  return { state, effects, result, event, duplicate: false };
}

function buildGeneralGenerationRequest(state, effect, idempotencyKey) {
  const preferences = state.privatePlayers?.[effect.accountId] || {};
  return {
    task: "general.generate",
    keyword: "[[FYOW:TASK:general.generate:v1]]",
    idempotencyKey: String(idempotencyKey),
    input: {
      schema: "fyow.general-generate-request/2",
      world: "这个世界战火纷飞，蛮夷遍地，但资源丰饶。各路有志之士带着自己的志趣，试图统治这片大陆。只有天生拥有慧眼的人才有统治的可能性。",
      gender: effect.gender,
      orientation: ["men", "women", "any"].includes(preferences.orientation) ? preferences.orientation : "any",
      population: effect.population,
      resourceGrade: effect.resourceGrade,
      location: { x: effect.x, y: effect.y },
      generationKind: effect.initial ? "initial-general" : "discovered-general",
      directionTags: effect.initial ? [] : normalizedCharacterTags(effect.directionTags).slice(0, 3),
      initialWish: effect.initial ? String(effect.initialWish || "").slice(0, 500) : "",
      instruction: effect.initial
        ? "initialWish 是最高优先级绑定要求，逐项落实用户明确特征；仅依据 orientation、gender 与 initialWish 生成初始良将，不使用人物设定标签。输入简短时围绕已有线索主动补全，写成鲜明、自洽、可长期互动的完整人物。外貌信息必须拆入 heightCm、weightKg、measurements 和 appearanceSetting；除这些外的出身、性格、志趣、军事能力、弱点、当前处境与关系倾向全部写入 coreSetting。核心设定长度自由，不要为凑字数重复内容；power 只是兼容字段，实际初始战力由游戏规则统一分配。"
        : "将 directionTags（标签及其可选注释）全部作为本次人物生成方向，并保证人物性别严格符合 gender。外貌信息必须拆入 heightCm、weightKg、measurements 和 appearanceSetting，其余完整人物背景全部写入 coreSetting。"
    }
  };
}

function buildGeneralDialogueRequest(state, general, player, topic, now, battleReport = null) {
  const captive = general.status === "captured" && general.loyalToAccountId !== player.accountId;
  const formerLords = formerLordRouting(state, general, player.accountId);
  const playerContext = clone(state.privatePlayers?.[player.accountId]?.playerContext || null);
  ensurePowerProgress(player, DEFAULT_PLAYER_BASE_POWER);
  ensureGeneralTalent(general, state.seed);
  const deployedAveragePower = deployedGeneralAveragePower(state);
  const opposingAveragePower = opposingDeployedGeneralAveragePower(state, player.accountId);
  const recentInteractions = modelRecentInteractions(general);
  if (battleReport) recentInteractions.push({
    year: gameYear(state, Number(battleReport.createdAt || now)),
    speakerName: player.displayName,
    kind: "battle-report",
    category: "deed",
    summary: battleReportSummary(battleReport, state),
    emotion: "",
    userText: "",
    reply: "",
    narration: ""
  });
  return {
    task: captive ? "general.captive-dialogue" : "general.dialogue",
    keyword: `${captive ? "[[FYOW:TASK:general.captive-dialogue:v1]]" : "[[FYOW:TASK:general.dialogue:v1]]"}\n${general.name}`,
    input: {
      schema: "fyow.general-dialogue-request/3",
      interactionMode: captive ? "captive" : "ordinary",
      general: {
        name: general.name, gender: general.gender,
        heightCm: general.heightCm, weightKg: general.weightKg, measurements: clone(general.measurements),
        appearanceSetting: general.appearanceSetting, coreSetting: general.coreSetting || general.setting,
        power: general.power, trainingLevel: general.trainingLevel,
        talent: { ...clone(general.talent), summary: talentSummary(general, state.seed) },
        memory: general.memoryText, memoryEntries: clone(general.memory?.entries || []), intimacy: general.memory?.intimacy?.[player.accountId] || 0,
        masterHistory: modelMasterHistory(state, general), captivityHistory: modelCaptivityHistory(state, general),
        recentInteractions
      },
      speaker: {
        name: player.displayName,
        power: player.power,
        deployedGeneralAveragePower: deployedAveragePower,
        opposingDeployedGeneralAveragePower: opposingAveragePower,
        context: playerContext
      },
      allowedFormerLords: formerLords.map(({ recipientKey, displayName }) => ({ recipientKey, displayName })),
      topic,
      replyStyle: "只输出一个 JSON 对象，并且必须完整放在 ```json 与 ``` 代码块中，代码块外禁止任何文字。字段固定为：reply（将领直接说出口的话，40～100 个汉字，1～3 句，最多 180 个汉字；不要添加姓名前缀，不写动作、心理或环境）；narration（可选的回复下方旁白，0～120 个汉字；只写将领和玩家可观察到的动作、表情、姿态、衣着或外观变化，不写心理、环境或语言；没有合适旁白时返回空字符串）；command（null，或 surrender，或 send-letter，或 appearance-change）；send-letter 时必须提供 recipientKey、purpose（写信目的）和 guidance（给写信模型的简短指导），不得直接生成正文；appearance-change 时必须提供 note（简略说明要变更的外观内容）；memoryUpdate（category 为 speech/deed，summary 1～120 字，emotion 1～40 字，intimacyDelta 为 -5～5 的整数，compactMemory 为同时包含“言谈：”与“经历：”且不超过 1000 字的完整记忆）。必须严格输出如下结构：```json\n{\"reply\":\"...\",\"narration\":\"\",\"command\":null,\"memoryUpdate\":{\"category\":\"speech\",\"summary\":\"...\",\"emotion\":\"...\",\"intimacyDelta\":1,\"compactMemory\":\"言谈：...\\n经历：...\"}}\n```",
      gameYear: gameYear(state, now)
    },
    routing: { formerLords: formerLords.map(({ recipientKey, accountId, displayName }) => ({ recipientKey, accountId, displayName })) }
  };
}

function buildGeneralLetterRequest(state, general, player, proposal = {}, now = Date.now()) {
  const allowed = Array.isArray(proposal.allowedRecipients) && proposal.allowedRecipients.length
    ? proposal.allowedRecipients
    : formerLordRouting(state, general, player.accountId);
  return {
    task: "general.letter",
    keyword: `[[FYOW:TASK:general.letter:v1]]\n${general.name}`,
    idempotencyKey: String(proposal.idempotencyKey || crypto.randomUUID()),
    input: {
      schema: "fyow.general-letter-request/1",
      kind: String(proposal.kind || "general").slice(0, 40),
      purpose: String(proposal.purpose || "向收信人说明近况").slice(0, 300),
      guidance: String(proposal.guidance || "").slice(0, 800),
      gameYear: gameYear(state, now),
      general: {
        name: general.name, gender: general.gender,
        appearanceSetting: general.appearanceSetting,
        coreSetting: general.coreSetting || general.setting,
        power: general.power, trainingLevel: general.trainingLevel,
        memory: general.memoryText,
        memoryEntries: clone(general.memory?.entries || []),
        masterHistory: modelMasterHistory(state, general),
        captivityHistory: modelCaptivityHistory(state, general),
        interactionHistory: modelRecentInteractions(general)
      },
      sender: { name: player.displayName, context: clone(state.privatePlayers?.[player.accountId]?.playerContext || null) },
      allowedRecipients: allowed.map(item => ({ recipientKey: item.recipientKey, displayName: item.displayName })),
      instruction: "只输出一个 JSON 对象，字段固定为 recipientKey 和 text。recipientKey 必须逐字取自 allowedRecipients；text 为 1～1000 字中文书信正文。不得输出解释、账号编号或其他顶层字段。"
    },
    routing: { recipients: allowed.map(({ recipientKey, accountId, displayName }) => ({ recipientKey, accountId, displayName })) }
  };
}

function buildGeneralAppearanceRequest(state, general, player, note, now = Date.now()) {
  return {
    task: "general.appearance-edit",
    keyword: `[[FYOW:TASK:general.appearance-edit:v1]]\n${general.name}`,
    idempotencyKey: crypto.randomUUID(),
    input: {
      schema: "fyow.general-appearance-edit-request/1",
      instruction: "只按照外观变更说明编辑外观设定；保留未被要求变更的内容，不主动添加、篡改或删减其他设定。可以处理衣着、发型、身体改造等任何明确要求。只输出一个 JSON 对象，字段固定为 appearanceSetting，值为编辑后的完整外观设定；不要输出其他字段或解释。",
      gameYear: gameYear(state, now),
      changeNote: String(note).slice(0, 1000),
      general: {
        name: general.name, gender: general.gender,
        currentAppearanceSetting: general.appearanceSetting,
        coreSetting: general.coreSetting || general.setting,
        interactionHistory: modelRecentInteractions(general)
      },
      requester: { name: player.displayName, context: clone(state.privatePlayers?.[player.accountId]?.playerContext || null) }
    }
  };
}

function buildPlayerProfileContextRequest(profile, idempotencyKey) {
  const source = profile && typeof profile === "object" ? profile : {};
  return {
    task: "player.profile-context",
    keyword: "[[FYOW:TASK:player.profile-context:v1]]",
    idempotencyKey: String(idempotencyKey),
    input: {
      schema: "fyow.player-profile-context-request/1",
      displayName: String(source.displayName || "玩家").trim().slice(0, 80),
      label: String(source.label || "").trim().slice(0, 80),
      basicInfo: String(source.basicInfo || "").trim().slice(0, 6000),
      appearance: String(source.appearance || "").trim().slice(0, 3000),
      fullSetting: String(source.info || "").trim().slice(0, 9000),
      instruction: "用户明确内容均为不可违背的事实；在符合这些事实的前提下，结合世界观主动补全缺失的出身经历、性格、志趣、能力、缺点、立场、外貌、说话方式与关系倾向。四个输出字段都要有实质内容，禁止使用未提供、暂无、不详、未知、没有说明或待补充等占位措辞。"
    }
  };
}

function buildGeneralMemoryUpdateRequest(state, general, player, interaction, now) {
  ensurePowerProgress(player, DEFAULT_PLAYER_BASE_POWER);
  ensureGeneralTalent(general, state.seed);
  return {
    task: "general.memory.update",
    keyword: `[[FYOW:TASK:general.memory.update:v1]]\n${general.name}`,
    idempotencyKey: String(interaction?.idempotencyKey || crypto.randomUUID()),
    input: {
      schema: "fyow.general-memory-update-request/2",
      gameYear: gameYear(state, now),
      general: {
        name: general.name,
        gender: general.gender,
        heightCm: general.heightCm,
        weightKg: general.weightKg,
        measurements: clone(general.measurements),
        appearanceSetting: general.appearanceSetting,
        coreSetting: general.coreSetting || general.setting,
        power: general.power,
        trainingLevel: general.trainingLevel,
        talent: { ...clone(general.talent), summary: talentSummary(general, state.seed) },
        priorMemory: general.memoryText,
        memoryEntries: clone(general.memory?.entries || []),
        masterHistory: modelMasterHistory(state, general),
        captivityHistory: modelCaptivityHistory(state, general),
        recentInteractions: modelRecentInteractions(general)
      },
      speaker: {
        name: player.displayName,
        power: player.power,
        deployedGeneralAveragePower: deployedGeneralAveragePower(state),
        opposingDeployedGeneralAveragePower: opposingDeployedGeneralAveragePower(state, player.accountId),
        context: clone(state.privatePlayers?.[player.accountId]?.playerContext || null)
      },
      interaction: {
        mode: general.status === "captured" ? "captive" : "ordinary",
        userText: String(interaction?.userText || "").slice(0, 240),
        reply: String(interaction?.reply || "").slice(0, 600)
      },
      instruction: "把本次互动归入言谈或经历，更新亲密度，并把旧记忆与本次事件压缩成不超过1000个汉字的完整记忆。历任主公、被俘与降服事实必须保留。"
    }
  };
}

function publicGeneralState(general) {
  ensureGeneralProfile(general);
  const result = {
    id: String(general?.id || ""),
    name: String(general?.name || "无名将领").slice(0, 24),
    gender: ["male", "female"].includes(general?.gender) ? general.gender : "female",
    heightCm: clamp(Math.round(Number(general?.heightCm) || (general?.gender === "female" ? 166 : 178)), 120, 230),
    weightKg: clamp(Math.round((Number(general?.weightKg) || (general?.gender === "female" ? 55 : 72)) * 10) / 10, 30, 250),
    measurements: normalizedMeasurements(general?.measurements, general?.gender),
    appearanceSetting: String(general?.appearanceSetting || "").slice(0, 350),
    coreSetting: String(general?.coreSetting || general?.setting || "").slice(0, MAX_GENERAL_CORE_SETTING_LENGTH),
    setting: String(general?.coreSetting || general?.setting || "").slice(0, MAX_GENERAL_CORE_SETTING_LENGTH),
    basePower: Math.max(1, Math.trunc(Number(general?.basePower || general?.power || 300))),
    trainingLevel: clamp(Math.trunc(Number(general?.trainingLevel) || 0), 0, MAX_TRAINING_LEVEL),
    power: Math.max(0, Math.trunc(Number(general?.power || 0))),
    cultivationCount: clamp(Math.trunc(Number(general?.cultivationCount) || 0), 0, CULTIVATION_RANGES.length),
    experience: Number(general?.experience || 0),
    experienceRequired: generalExperienceRequirement(general),
    defenseBonusRate: generalDefenseCultivationRate(general),
    defenseBonusPower: generalDefenseBonusPower(general),
    talent: clone(general.talent),
    talentSummary: talentSummary(general),
    holderAccountId: String(general?.holderAccountId || ""),
    status: "deployed",
    location: {
      x: Math.trunc(Number(general?.location?.x || 0)),
      y: Math.trunc(Number(general?.location?.y || 0))
    },
    masterHistory: clone(general?.masterHistory || []),
    captivityHistory: clone(general?.captivityHistory || []),
    interactionHistory: clone(general?.interactionHistory || []),
    memory: clone(general?.memory || { entries: [], intimacy: {} }),
    memoryText: String(general?.memoryText || "").slice(0, 1000),
    loyalToAccountId: String(general?.loyalToAccountId || ""),
    capturedFromAccountId: general?.capturedFromAccountId ? String(general.capturedFromAccountId) : null,
    capturedAtYear: general?.capturedAtYear == null ? null : Number(general.capturedAtYear)
  };
  return result;
}

function projectedCultivationQuote(state, general, player, now) {
  const count = clamp(Math.trunc(Number(general?.cultivationCount) || 0), 0, CULTIVATION_RANGES.length);
  if (count >= CULTIVATION_RANGES.length) return { attempt: null, remaining: 0, unlocked: false, disabledReason: "completed" };
  const status = general.status;
  try {
    const quoteGeneral = status === "deployed" || status === "captured" ? { ...general, status: "waiting" } : general;
    const quote = cultivationQuote(quoteGeneral, player, now, { state });
    return { ...quote, eligible: status !== "deployed" && status !== "captured", disabledReason: status === "deployed" ? "deployed" : status === "captured" ? "captured" : null };
  } catch (error) {
    return { attempt: count + 1, remaining: CULTIVATION_RANGES.length - count, unlocked: false, eligible: false, disabledReason: String(error?.message || error) };
  }
}

function projectedPlayerCultivationQuote(state, player, now) {
  const count = clamp(Math.trunc(Number(player?.cultivationCount) || 0), 0, CULTIVATION_RANGES.length);
  if (count >= CULTIVATION_RANGES.length) return { attempt: null, remaining: 0, unlocked: false, materialCount: 0, disabledReason: "completed" };
  try {
    const quote = cultivationQuote(player, player, now, { state, targetType: "player" });
    const marching = Boolean(jobFor(state, job => job.type === "march" && job.accountId === player.accountId));
    return { ...quote, eligible: !marching, disabledReason: marching ? "marching" : null };
  } catch (error) {
    return { attempt: count + 1, remaining: CULTIVATION_RANGES.length - count, unlocked: false, materialCount: 0, eligible: false, disabledReason: String(error?.message || error) };
  }
}

function projectWorldState(state, viewerAccountId, nowValue = Date.now()) {
  const viewer = String(viewerAccountId || "");
  const now = Number(nowValue);
  const players = clone(state.players || {});
  for (const [accountId, player] of Object.entries(players)) {
    ensurePowerProgress(player, DEFAULT_PLAYER_BASE_POWER);
    if (accountId === viewer) {
      if (player.position) {
        const modifiers = actionTalentModifiers(state, accountId, "march", player.position, { carriedGeneralIds: activeCarriedGeneralIds(player), now });
        player.marchModifiers = {
          durationMultiplier: 1 + modifiers.marchDuration,
          costMultiplier: 1 + modifiers.marchCost
        };
      }
      player.materials = materialInventoryState(state.privatePlayers?.[accountId]);
      player.cultivationQuote = projectedPlayerCultivationQuote(state, state.players[accountId], now);
      continue;
    }
    delete player.gold;
    delete player.fieldArmySoldiers;
    delete player.carriedGeneralIds;
    delete player.position;
    delete player.joinedAt;
    delete player.basePower;
    delete player.trainingLevel;
    delete player.power;
    delete player.retreatPath;
  }
  const generals = {};
  for (const [id, general] of Object.entries(state.generals || {})) {
    if (general.status === "deployed") generals[id] = publicGeneralState(general);
    else if (general.holderAccountId === viewer) generals[id] = clone(general);
    if (generals[id] && String(general.holderAccountId) === viewer) {
      ensureGeneralTalent(generals[id], state.seed);
      generals[id].talentSummary = talentSummary(generals[id], state.seed);
      if (players[viewer]) generals[id].cultivationQuote = projectedCultivationQuote(state, general, players[viewer], now);
    }
  }
  const projectedCells = clone(state.cells || {});
  for (const [key, cell] of Object.entries(projectedCells)) {
    if (!cell?.ownerAccountId) continue;
    const [x, y] = key.split(",").map(Number);
    cell.defensivePower = regionDefenseQuote(state, x, y, now).power;
    if (String(cell.ownerAccountId) === viewer) {
      const trainingModifiers = actionTalentModifiers(state, viewer, "training", { x, y }, { armySize: 0, now });
      cell.trainingCostMultiplier = 1 + trainingModifiers.trainingCost;
      cell.trainingYieldModifier = trainingModifiers.trainingYield;
    }
  }
  return {
    schema: state.schema,
    gameId: state.gameId,
    seasonId: state.seasonId,
    seed: state.seed,
    width: state.width,
    height: state.height,
    startedAt: state.startedAt,
    // The public snapshot needs the immutable season authority binding so
    // guests can validate locally generated rewards after a cold start.
    authorityAccountId: state.authorityAccountId ? String(state.authorityAccountId) : null,
    revision: state.revision,
    cells: projectedCells,
    players,
    bans: clone(state.bans || {}),
    playerEpochs: clone(state.playerEpochs || {}),
    privatePlayers: viewer && state.privatePlayers?.[viewer] ? { [viewer]: clone(state.privatePlayers[viewer]) } : {},
    generals,
    marketListings: Object.fromEntries(Object.entries(state.marketListings || {}).map(([id, listing]) => [id, publicMarketListingState(state, listing)])),
    marketSales: clone(state.marketSales || {}),
    jobs: Object.fromEntries(Object.entries(state.jobs || {}).filter(([, job]) => job.accountId === viewer)),
    treasureSpawns: clone(state.treasureSpawns || {}),
    claimedTreasures: clone(state.claimedTreasures || {}),
    treasureEpoch: Math.max(0, Math.trunc(Number(state.treasureEpoch) || 0))
  };
}

module.exports = {
  GRID_GAME_ID,
  GRID_SIZE,
  RESOURCE_GRADES,
  TERRAIN_TYPES,
  CENTRAL_LAYER_MULTIPLIERS,
  CENTRAL_LAYER_BOUNDARIES,
  CENTRAL_NEUTRAL_RADIUS,
  SPAWN_NEUTRAL_RADIUS,
  SPAWN_EDGE_BAND,
  MINUTE,
  HOUR,
  MARCH_MS_PER_CELL,
  MINING_GRADE_YIELD_MULTIPLIERS,
  MARKET_RELIST_COOLDOWN_MS,
  ACTIVE_CARRIED_GENERAL_LIMIT,
  CULTIVATION_RANGES,
  GENERAL_EXPERIENCE_REQUIREMENTS,
  GENERAL_TRAINING_EXPERIENCE_MINUTES,
  GENERAL_IDLE_EXPERIENCE_MINUTES,
  GENERAL_DEFENSE_CULTIVATION_BONUSES,
  PLAYER_CULTIVATION_GOLD_MULTIPLIER,
  PLAYER_CULTIVATION_POWER_MULTIPLIER,
  MATERIAL_IDS,
  CULTIVATION_MATERIAL_IDS,
  RESOURCE_YIELD_FORMULA_VERSION,
  MINING_DURATION_MS,
  MAX_CONCURRENT_MINING_JOBS,
  MINING_COOLDOWN_MIN_MS,
  MINING_COOLDOWN_MAX_MS,
  DIALOGUE_COOLDOWN_MS,
  TRAINING_GENERAL_DISCOVERY_PER_SOLDIER,
  keyOf,
  normalizedCenterDistances,
  centralLayer,
  centralLayerMultiplier,
  centralLayerColor,
  isCentralNeutralCell,
  staticCell,
  createWorld,
  chooseCapital,
  resetPlayerState,
  dynamicCell,
  publicGeneralState,
  publicMarketGeneralState,
  publicMarketListingState,
  generalDiscoveryChance,
  trainingGeneralDiscoveryChance,
  pendingGeneralDiscoveries,
  queueGeneralDiscovery,
  removePendingGeneralDiscovery,
  normalizedCharacterTags,
  resourceCycleMs,
  resourceYield,
  miningCooldownMs,
  trainDurationMs,
  trainingPower,
  ensurePowerProgress,
  ensureGeneralExperience,
  generalExperienceRequirement,
  grantGeneralExperience,
  generalBattleExperienceGain,
  generalMarchExperienceGain,
  generalDefenseCultivationRate,
  generalDefenseBonusPower,
  ensureGeneralProfile,
  generatedGeneralPower,
  ensureGeneralTalent,
  talentSummary,
  generalTalentState,
  materialInventoryState,
  cultivationQuote,
  playerCultivationActionQuote,
  treasureState,
  scatterTreasures,
  powerTrainingCost,
  powerTrainingDurationMs,
  powerTrainingQuote,
  marchDurationMs,
  marchCost,
  marchQuote,
  findMarchPath,
  battleCasualties,
  regionPower,
  regionDefenseQuote,
  gameYear,
  formatGeneralMemory,
  appendGeneralMemory,
  createFallbackGeneral,
  settleWorld,
  applyIntent,
  buildGeneralGenerationRequest,
  buildGeneralDialogueRequest,
  buildGeneralLetterRequest,
  buildGeneralAppearanceRequest,
  buildPlayerProfileContextRequest,
  buildGeneralMemoryUpdateRequest,
  projectWorldState
};
