"use strict";

const crypto = require("node:crypto");

// Deterministic planning simulation for the 64x64 grid economy. This module is
// intentionally does not mutate world state. Its default mining model mirrors
// the live engine; the legacy model remains available for regression comparison.

const GRID_SIZE = 64;
const RESOURCE_GRADES = Object.freeze(["D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S-", "S", "S+"]);
const MATERIAL_PROGRESS = Object.freeze({ white: 8, green: 20, blue: 42, purple: 78, gold: 135, "red-ascend": 0, "red-reroll": 0 });
const MATERIAL_TIERS = Object.freeze(Object.keys(MATERIAL_PROGRESS));
const PROPOSED_MINING_BALANCE = Object.freeze({ baseHourlyGold: 400, populationHourlyFactor: 0.09, rankMultiplierPerLevel: 0.08 });

const CULTIVATION_RANGES = Object.freeze([
  Object.freeze({ attempt: 1, gateHours: 6, goldMin: 5000, goldMax: 8000, powerGainPctMin: 6, powerGainPctMax: 10, materialCount: 1, materialChoices: MATERIAL_TIERS }),
  Object.freeze({ attempt: 2, gateHours: 48, goldMin: 12000, goldMax: 18000, powerGainPctMin: 9, powerGainPctMax: 14, materialCount: 1, materialChoices: MATERIAL_TIERS }),
  Object.freeze({ attempt: 3, gateHours: 168, goldMin: 30000, goldMax: 45000, powerGainPctMin: 13, powerGainPctMax: 20, materialCount: 1, materialChoices: MATERIAL_TIERS }),
  Object.freeze({ attempt: 4, gateHours: 360, goldMin: 70000, goldMax: 100000, powerGainPctMin: 18, powerGainPctMax: 28, materialCount: 1, materialChoices: MATERIAL_TIERS }),
  Object.freeze({ attempt: 5, gateHours: 576, goldMin: 160000, goldMax: 240000, powerGainPctMin: 25, powerGainPctMax: 40, materialCount: 1, materialChoices: MATERIAL_TIERS })
]);

const BALANCE_BASELINE = Object.freeze({
  players: 20,
  days: 30,
  gridSize: GRID_SIZE,
  marchSecondsPerCell: 30,
  startingGold: 500,
  miningCycleSeconds: Object.freeze({ min: 60, max: 3600 }),
  miningFormula: "max(1, round(((400 + population * 0.09) * (1 + resourceRank * 0.08)) * cycleSeconds / 3600)) gold per cycle",
  training: Object.freeze({ costPerSoldier: 2, durationBaseSeconds: 60, durationPerFiveSoldiersSeconds: 1, maxGarrisonPct: 20 }),
  cultivationAttempts: 5,
  cultivation: Object.freeze({ firstAttemptGateHours: 6, materialPerAttempt: 1 }),
  simulationStepHours: 6,
  treasureScatter: Object.freeze({ count: 240, manual: true, redAscend: 0, redReroll: 0, simulatedClaimChancePerStep: 0.45, simulatedClaimTargetPerPlayer: 5 })
});

const TALENT_POTENCY = Object.freeze([
  Object.freeze({ rarity: "white", progressMin: 0, progressMax: 99, potencyMinPct: 0.2, potencyMaxPct: 0.6 }),
  Object.freeze({ rarity: "green", progressMin: 100, progressMax: 219, potencyMinPct: 0.8, potencyMaxPct: 1.5 }),
  Object.freeze({ rarity: "blue", progressMin: 220, progressMax: 359, potencyMinPct: 1.8, potencyMaxPct: 3.0 }),
  Object.freeze({ rarity: "purple", progressMin: 360, progressMax: 519, potencyMinPct: 3.5, potencyMaxPct: 5.5 }),
  Object.freeze({ rarity: "gold", progressMin: 520, progressMax: 699, potencyMinPct: 6.5, potencyMaxPct: 9.0 }),
  Object.freeze({ rarity: "red", progressMin: 700, progressMax: 1000, potencyMinPct: 11.0, potencyMaxPct: 16.0 })
]);

const TALENT_CAPS = Object.freeze({
  marchDurationPct: -45,
  marchCostPct: -45,
  combatPowerPct: 60,
  miningDurationPct: -45,
  miningYieldPct: 60,
  trainingDurationPct: -45,
  trainingCostPct: -45,
  trainingYieldPct: 60,
  cultivationCostPct: -45,
  cultivationPowerPct: 60,
  discoveryChancePct: 12
});

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rng(seed) {
  let state = hashString(seed) || 1;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 3266489917) >>> 0;
    state ^= state >>> 13;
    return (state >>> 0) / 4294967296;
  };
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function entropy(seed, ...parts) {
  return crypto.createHash("sha256").update([seed, ...parts].join("\0")).digest();
}

function staticCell(seed, x, y) {
  const bytes = entropy(String(seed), "cell", x, y);
  const population = 100 + (bytes.readUInt32BE(0) % 9901);
  const roll = bytes.readUInt16BE(4) / 0x10000;
  const resourceRank = Math.max(0, Math.min(14, Math.floor(Math.pow(roll, 1.7) * RESOURCE_GRADES.length)));
  const cycleMs = Math.round(60_000 + (resourceRank / 14) * 3_540_000);
  const cycleSeconds = cycleMs / 1000;
  const legacyYieldPerCycle = Math.max(1, Math.floor(population * (resourceRank + 2) / 180));
  const cell = { population, resourceRank, resourceGrade: RESOURCE_GRADES[resourceRank], cycleMs, cycleSeconds };
  return { ...cell, yieldPerCycle: actualYieldPerCycle(cell), legacyYieldPerCycle };
}

function chooseCapital(seed, accountId, occupied) {
  const start = entropy(seed, "capital", accountId).readUInt16BE(0) % (GRID_SIZE * GRID_SIZE);
  for (let offset = 0; offset < GRID_SIZE * GRID_SIZE; offset += 1) {
    const index = (start + offset * 97) % (GRID_SIZE * GRID_SIZE);
    const position = { x: index % GRID_SIZE, y: Math.floor(index / GRID_SIZE) };
    const key = `${position.x},${position.y}`;
    if (!occupied.has(key)) { occupied.add(key); return position; }
  }
  throw new Error("No capital cells remain");
}

function scatterMaterial(seed, index) {
  const roll = entropy(seed, "treasure-material", 1, index).readUInt32BE(0) / 0x100000000;
  if (roll < 0.06) return "gold";
  if (roll < 0.18) return "purple";
  if (roll < 0.4) return "blue";
  if (roll < 0.7) return "green";
  return "white";
}

function chooseMaterial(materials) {
  return [...MATERIAL_TIERS].reverse().find(tier => materials[tier] > 0) || null;
}

function actualHourlyRate(cell) {
  return (PROPOSED_MINING_BALANCE.baseHourlyGold + cell.population * PROPOSED_MINING_BALANCE.populationHourlyFactor)
    * (1 + PROPOSED_MINING_BALANCE.rankMultiplierPerLevel * cell.resourceRank);
}

function actualYieldPerCycle(cell) {
  return Math.max(1, Math.round(actualHourlyRate(cell) * cell.cycleMs / 3_600_000));
}

function miningValues(cell, miningModel) {
  const yieldPerCycle = miningModel === "legacy" ? cell.legacyYieldPerCycle : cell.yieldPerCycle;
  return { yieldPerCycle, hourlyRate: yieldPerCycle / (cell.cycleMs / 3_600_000) };
}

function strictlyIncreasesByRankAtSamePopulation(miningModel) {
  for (let population = 100; population <= 10000; population += 1) {
    let previousHourlyRate = -Infinity;
    for (let resourceRank = 0; resourceRank < RESOURCE_GRADES.length; resourceRank += 1) {
      const cycleMs = Math.round(60_000 + (resourceRank / 14) * 3_540_000);
      const cell = {
        population,
        resourceRank,
        cycleMs,
        cycleSeconds: cycleMs / 1000,
        legacyYieldPerCycle: Math.max(1, Math.floor(population * (resourceRank + 2) / 180))
      };
      cell.yieldPerCycle = actualYieldPerCycle(cell);
      const hourlyRate = miningValues(cell, miningModel).hourlyRate;
      if (hourlyRate <= previousHourlyRate) return false;
      previousHourlyRate = hourlyRate;
    }
  }
  return true;
}

function prepareTreasureScatter(random, fixtures, seed) {
  const occupied = new Set(fixtures.map(item => `${item.position.x},${item.position.y}`));
  const locations = [];
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      if (!occupied.has(`${x},${y}`)) locations.push({ x, y, order: entropy(seed, "treasure-scatter", "simulation", 1, x, y).toString("hex") });
    }
  }
  locations.sort((left, right) => left.order.localeCompare(right.order));
  const activeLocations = locations.slice(0, BALANCE_BASELINE.treasureScatter.count);
  const nearestDistances = fixtures.map(fixture => Math.min(...activeLocations.map(location => Math.abs(location.x - fixture.position.x) + Math.abs(location.y - fixture.position.y))));
  const pool = Array.from({ length: BALANCE_BASELINE.treasureScatter.count }, (_, index) => scatterMaterial(seed, index));
  const initialByTier = Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, pool.filter(item => item === tier).length]));
  const schedules = Array.from({ length: fixtures.length }, () => []);
  const nextClaimAt = Array(fixtures.length).fill(0);
  for (let round = 0; round < BALANCE_BASELINE.treasureScatter.simulatedClaimTargetPerPlayer; round += 1) {
    for (let playerIndex = 0; playerIndex < fixtures.length && pool.length; playerIndex += 1) {
      const itemIndex = Math.floor(random() * pool.length);
      const [material] = pool.splice(itemIndex, 1);
      let claimAtHours = nextClaimAt[playerIndex] + BALANCE_BASELINE.simulationStepHours;
      while (random() >= BALANCE_BASELINE.treasureScatter.simulatedClaimChancePerStep) claimAtHours += BALANCE_BASELINE.simulationStepHours;
      schedules[playerIndex].push({ material, claimAtHours });
      nextClaimAt[playerIndex] = claimAtHours;
    }
  }
  return {
    schedules,
    initialByTier,
    densityPct: round2(BALANCE_BASELINE.treasureScatter.count / (GRID_SIZE * GRID_SIZE) * 100),
    nearestDistance: { average: round2(nearestDistances.reduce((sum, value) => sum + value, 0) / nearestDistances.length), max: Math.max(...nearestDistances), playersWithinFiveCells: nearestDistances.filter(value => value <= 5).length },
    remainingByTier: Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, pool.filter(item => item === tier).length])),
    remaining: pool.length
  };
}

function simulatePlayer(random, seed, id, position, cell, days, claimSchedule, miningModel) {
  const { x, y } = position;
  const mining = miningValues(cell, miningModel);
  const uptime = 1;
  let miningCycles = 0;
  let miningGold = 0;
  let gold = BALANCE_BASELINE.startingGold;
  let trainingGold = 0;
  let marchGold = 0;
  let battleLoot = 0;
  let battles = 0;
  let battleWins = 0;
  let marchCells = 0;
  let soldiers = Math.max(1, Math.floor(cell.population * 0.1));
  let trainingSessions = 0;
  let trainingHours = 0;
  const materials = Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, 0]));
  const materialsFound = Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, 0]));
  const materialsUsed = Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, 0]));
  const cultivation = [];
  const cultivationQuotes = CULTIVATION_RANGES.map(range => ({
    range,
    gold: range.goldMin + Math.floor(random() * (range.goldMax - range.goldMin + 1))
  }));
  let discoveredGenerals = 0;
  let treasures = 0;
  let expectedGenerals = 0;
  let goldAtFirstGate = null;

  const ticks = days * (24 / BALANCE_BASELINE.simulationStepHours);
  for (let tick = 1; tick <= ticks; tick += 1) {
    const elapsedHours = tick * BALANCE_BASELINE.simulationStepHours;
    const settledMiningCycles = Math.floor(elapsedHours * 3_600_000 * uptime / cell.cycleMs);
    const newMiningCycles = settledMiningCycles - miningCycles;
    miningCycles = settledMiningCycles;
    const nextMiningGold = miningGold + newMiningCycles * mining.yieldPerCycle;
    gold += nextMiningGold - miningGold;
    miningGold = nextMiningGold;
    if (elapsedHours === BALANCE_BASELINE.cultivation.firstAttemptGateHours) goldAtFirstGate = gold;

    for (const claim of claimSchedule.filter(item => item.claimAtHours === elapsedHours)) {
      materials[claim.material] += 1;
      materialsFound[claim.material] += 1;
      treasures += 1;
    }

    const quote = cultivationQuotes[cultivation.length];
    const range = quote?.range;
    const selectedMaterial = chooseMaterial(materials);
    if (range && elapsedHours >= range.gateHours && gold >= quote.gold && selectedMaterial) {
      const goldRatio = (quote.gold - range.goldMin) / (range.goldMax - range.goldMin);
      const powerGainPct = round2(range.powerGainPctMin + goldRatio * (range.powerGainPctMax - range.powerGainPctMin));
      cultivation.push({
        attempt: range.attempt,
        completedAtHours: elapsedHours,
        gold: quote.gold,
        powerGainPct,
        material: selectedMaterial,
        materialCount: 1,
        talentProgress: MATERIAL_PROGRESS[selectedMaterial]
      });
      gold -= quote.gold;
      materials[selectedMaterial] -= 1;
      materialsUsed[selectedMaterial] += 1;
    }

    if (tick % 4 !== 0) continue;
    if (random() < 0.42) {
      const capacity = Math.floor(cell.population * BALANCE_BASELINE.training.maxGarrisonPct / 100);
      const amount = Math.min(80 + Math.floor(random() * 121), Math.max(0, capacity - soldiers));
      const cost = amount * BALANCE_BASELINE.training.costPerSoldier;
      if (amount > 0 && gold >= cost) {
        trainingSessions += 1;
        trainingHours += (BALANCE_BASELINE.training.durationBaseSeconds + Math.ceil(amount / 5) * BALANCE_BASELINE.training.durationPerFiveSoldiersSeconds) / 3600;
        trainingGold += cost;
        gold -= cost;
        soldiers += amount;
      }
    }

    // Marches are short enough to be meaningful in a 30-second-per-cell world.
    if (random() < 0.65) {
      const distance = 1 + Math.floor(random() * 8);
      const force = Math.max(20, Math.floor(soldiers * (0.18 + random() * 0.15)));
      const cost = distance * (10 + Math.ceil(force / 100));
      if (gold < cost) continue;
      marchCells += distance;
      marchGold += cost;
      gold -= cost;
      battles += 1;
      const target = staticCell(seed, Math.floor(random() * GRID_SIZE), Math.floor(random() * GRID_SIZE));
      const enemy = Math.floor(target.population * 0.2);
      const attackerPower = force + 500 + 300;
      if (attackerPower > enemy) {
        battleWins += 1;
        const discoveryChance = 0.02 + ((target.population - 100) / 9900) * 0.23;
        expectedGenerals += discoveryChance;
        if (random() < discoveryChance) discoveredGenerals += 1;
      } else {
        soldiers = Math.max(20, soldiers - Math.floor(force * 0.2));
      }
    }

  }

  return {
    id,
    position: { x, y },
    cell,
    uptimePct: round2(uptime * 100),
    goldAtFirstGate,
    firstMinimumAffordableAtGate: goldAtFirstGate >= CULTIVATION_RANGES[0].goldMin,
    mining: {
      model: miningModel,
      cycles: miningCycles,
      gold: miningGold,
      cycleSeconds: cell.cycleSeconds,
      yieldPerCycle: mining.yieldPerCycle,
      hourlyRate: round2(mining.hourlyRate)
    },
    training: { sessions: trainingSessions, hours: round2(trainingHours), gold: trainingGold, soldiers },
    march: { cells: marchCells, seconds: marchCells * BALANCE_BASELINE.marchSecondsPerCell, gold: marchGold, battles, wins: battleWins },
    battleLoot,
    cultivation,
    cultivationCompleted: cultivation.length,
    discovery: {
      generals: discoveredGenerals,
      treasures,
      generalChancePctPerConquest: battleWins ? round2(expectedGenerals / battleWins * 100) : 0,
      treasureChancePctPerDay: null,
      expectedGenerals: round2(expectedGenerals),
      expectedTreasures: null
    },
    materials,
    materialsFound,
    materialsUsed,
    endingGold: gold
  };
}

function sumBy(players, selector) {
  return players.reduce((total, player) => total + Number(selector(player) || 0), 0);
}

function runSimulation(options = {}) {
  const seed = String(options.seed ?? "grid-balance-2026");
  const players = integer(options.players, BALANCE_BASELINE.players, 1, 200);
  const days = integer(options.days, BALANCE_BASELINE.days, 1, 365);
  const miningModel = options.miningModel === "legacy" ? "legacy" : "actual";
  const random = rng(seed);
  const occupied = new Set();
  const fixtures = Array.from({ length: players }, (_, index) => {
    const id = `player-${String(index + 1).padStart(2, "0")}`;
    const position = chooseCapital(seed, id, occupied);
    return { id, position, cell: staticCell(seed, position.x, position.y) };
  });
  const treasureScatter = prepareTreasureScatter(random, fixtures, seed);
  const playerRecords = fixtures.map((fixture, index) => simulatePlayer(random, seed, fixture.id, fixture.position, fixture.cell, days, treasureScatter.schedules[index], miningModel));
  const mapAffordability = [];
  const miningRateByGrade = Object.fromEntries(RESOURCE_GRADES.map(grade => [grade, []]));
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const cell = staticCell(seed, x, y);
      const { yieldPerCycle, hourlyRate } = miningValues(cell, miningModel);
      const cycles = Math.floor(BALANCE_BASELINE.cultivation.firstAttemptGateHours * 3_600_000 / cell.cycleMs);
      const gold = BALANCE_BASELINE.startingGold + cycles * yieldPerCycle;
      const hoursToAfford = Math.ceil(Math.max(0, CULTIVATION_RANGES[0].goldMin - BALANCE_BASELINE.startingGold) / yieldPerCycle) * cell.cycleMs / 3_600_000;
      mapAffordability.push({ gold, hoursToAfford });
      miningRateByGrade[cell.resourceGrade].push(hourlyRate);
    }
  }
  mapAffordability.sort((left, right) => left.gold - right.gold);
  const affordHours = mapAffordability.map(item => item.hoursToAfford).sort((left, right) => left - right);
  const percentile = (values, ratio) => round2(values[Math.floor((values.length - 1) * ratio)]);
  const cultivationGold = CULTIVATION_RANGES.reduce((acc, item) => ({ min: acc.min + item.goldMin, max: acc.max + item.goldMax }), { min: 0, max: 0 });
  const totalMiningGold = sumBy(playerRecords, player => player.mining.gold);
  const totalEndingGold = sumBy(playerRecords, player => player.endingGold);
  const totalBattles = sumBy(playerRecords, player => player.march.battles);
  const totalWins = sumBy(playerRecords, player => player.march.wins);
  return {
    seed,
    config: { players, days, gridSize: GRID_SIZE, marchSecondsPerCell: BALANCE_BASELINE.marchSecondsPerCell, miningModel },
    players: playerRecords,
    totals: {
      miningGold: totalMiningGold,
      endingGold: totalEndingGold,
      trainingGold: sumBy(playerRecords, player => player.training.gold),
      marchGold: sumBy(playerRecords, player => player.march.gold),
      battleLoot: sumBy(playerRecords, player => player.battleLoot),
      battles: totalBattles,
      battleWins: totalWins,
      winRatePct: round2(totalBattles ? totalWins / totalBattles * 100 : 0),
      marchCells: sumBy(playerRecords, player => player.march.cells),
      discoveredGenerals: sumBy(playerRecords, player => player.discovery.generals),
      treasures: sumBy(playerRecords, player => player.discovery.treasures),
      cultivationGold: sumBy(playerRecords, player => player.cultivation.reduce((total, item) => total + item.gold, 0)),
      cultivationTalentProgress: sumBy(playerRecords, player => player.cultivation.reduce((total, item) => total + item.talentProgress, 0))
    },
    averages: {
      miningGoldPerPlayer: round2(totalMiningGold / players),
      endingGoldPerPlayer: round2(totalEndingGold / players),
      generalsPerPlayer: round2(sumBy(playerRecords, player => player.discovery.generals) / players),
      treasuresPerPlayer: round2(sumBy(playerRecords, player => player.discovery.treasures) / players),
      firstCultivationGateHours: BALANCE_BASELINE.cultivation.firstAttemptGateHours,
      cultivationPowerGainPctPerPlayer: round2(sumBy(playerRecords, player => player.cultivation.reduce((total, item) => total + item.powerGainPct, 0)) / players),
      talentProgressPerPlayer: round2(sumBy(playerRecords, player => player.cultivation.reduce((total, item) => total + item.talentProgress, 0)) / players)
    },
    cultivation: {
      ranges: CULTIVATION_RANGES,
      totalGoldRange: cultivationGold,
      fifthAttempt: CULTIVATION_RANGES[4],
      timeline: Object.fromEntries(CULTIVATION_RANGES.map(range => {
        const hours = playerRecords.flatMap(player => player.cultivation.filter(item => item.attempt === range.attempt).map(item => item.completedAtHours));
        return [range.attempt, {
          playersCompleted: hours.length,
          playersCompletedAtGate: hours.filter(value => value === range.gateHours).length,
          earliestHours: hours.length ? Math.min(...hours) : null,
          averageHours: hours.length ? round2(hours.reduce((sum, value) => sum + value, 0) / hours.length) : null,
          latestHours: hours.length ? Math.max(...hours) : null
        }];
      }))
    },
    materialBalance: {
      source: "author-manual-scatter",
      automaticGeneration: false,
      defaultScatterCount: BALANCE_BASELINE.treasureScatter.count,
      defaultRedAscend: BALANCE_BASELINE.treasureScatter.redAscend,
      defaultRedReroll: BALANCE_BASELINE.treasureScatter.redReroll,
      initialScatterByTier: treasureScatter.initialByTier,
      mapDensityPct: treasureScatter.densityPct,
      nearestFromStartingCapitals: treasureScatter.nearestDistance,
      unclaimedAfterSimulationByTier: treasureScatter.remainingByTier,
      unclaimedAfterSimulation: treasureScatter.remaining,
      supplyPerPlayer: round2(BALANCE_BASELINE.treasureScatter.count / players),
      supplyCoveragePct: round2(BALANCE_BASELINE.treasureScatter.count / (players * CULTIVATION_RANGES.length) * 100),
      simulatedClaimPolicy: `up to ${BALANCE_BASELINE.treasureScatter.simulatedClaimTargetPerPlayer} targeted claims per player; each six-hour travel window succeeds at ${round2(BALANCE_BASELINE.treasureScatter.simulatedClaimChancePerStep * 100)}%`,
      requiredPerAttempt: 1,
      maximumRequiredPerPlayer: CULTIVATION_RANGES.length,
      allowedChoices: MATERIAL_TIERS,
      starterMaterial: null,
      foundTotal: Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, sumBy(playerRecords, player => player.materialsFound[tier])])),
      usedTotal: Object.fromEntries(MATERIAL_TIERS.map(tier => [tier, sumBy(playerRecords, player => player.materialsUsed[tier])])),
      playersCompletingAttempts: Object.fromEntries(CULTIVATION_RANGES.map(range => [range.attempt, playerRecords.filter(player => player.cultivationCompleted >= range.attempt).length]))
    },
    resources: {
      cycleSecondsRange: BALANCE_BASELINE.miningCycleSeconds,
      observedCycleSeconds: { min: Math.min(...playerRecords.map(player => player.mining.cycleSeconds)), max: Math.max(...playerRecords.map(player => player.mining.cycleSeconds)) },
      observedYieldPerCycle: { min: Math.min(...playerRecords.map(player => player.mining.yieldPerCycle)), max: Math.max(...playerRecords.map(player => player.mining.yieldPerCycle)) },
      goldPerHourByGrade: Object.fromEntries(RESOURCE_GRADES.map(grade => {
        const values = miningRateByGrade[grade].sort((left, right) => left - right);
        return [grade, { cells: values.length, average: round2(values.reduce((sum, value) => sum + value, 0) / values.length), median: round2(values[Math.floor(values.length / 2)]) }];
      })),
      firstCultivationAffordability: {
        miningModel,
        requiredGold: CULTIVATION_RANGES[0].goldMin,
        startingGold: BALANCE_BASELINE.startingGold,
        gateHours: BALANCE_BASELINE.cultivation.firstAttemptGateHours,
        mapCellsAffordable: mapAffordability.filter(item => item.gold >= CULTIVATION_RANGES[0].goldMin).length,
        mapCellsTotal: mapAffordability.length,
        mapAffordablePct: round2(mapAffordability.filter(item => item.gold >= CULTIVATION_RANGES[0].goldMin).length / mapAffordability.length * 100),
        samplePlayersAffordable: playerRecords.filter(player => player.firstMinimumAffordableAtGate).length,
        samplePlayersTotal: players,
        sampleAffordablePct: round2(playerRecords.filter(player => player.firstMinimumAffordableAtGate).length / players * 100),
        goldAtGate: { min: Math.min(...playerRecords.map(player => player.goldAtFirstGate)), median: percentile(playerRecords.map(player => player.goldAtFirstGate).sort((a, b) => a - b), 0.5), max: Math.max(...playerRecords.map(player => player.goldAtFirstGate)) },
        timeToAffordHours: { p25: percentile(affordHours, 0.25), median: percentile(affordHours, 0.5), p75: percentile(affordHours, 0.75), p90: percentile(affordHours, 0.9) },
        implementedParameters: miningModel === "actual" ? PROPOSED_MINING_BALANCE : null,
        strictlyIncreasesByRankAtSamePopulation: strictlyIncreasesByRankAtSamePopulation(miningModel)
      }
    },
    talent: {
      potency: TALENT_POTENCY,
      progressCap: 1000,
      modifierCaps: TALENT_CAPS,
      percentEffects: Object.fromEntries(TALENT_POTENCY.map(item => [item.rarity, { min: round2(item.potencyMinPct), max: round2(item.potencyMaxPct) }]))
    },
    formulas: {
      marchDuration: "distanceCells * 30 seconds",
      marchCost: "distanceCells * (10 + ceil(soldiers / 100)) gold",
      miningCycle: "60 + (resourceRank / 14) * 3540 seconds",
      miningYield: miningModel === "actual"
        ? "max(1, round(((400 + population * 0.09) * (1 + resourceRank * 0.08)) * cycleSeconds / 3600)) gold per cycle"
        : "max(1, floor(population * (resourceRank + 2) / 180)) gold per cycle (legacy comparison)",
      training: "cost = soldiers * 2 gold; duration = 60 + ceil(soldiers / 5) seconds, capped at 3600 seconds",
      generalDiscovery: "0.02 + ((population - 100) / 9900) * 0.23 per victorious neutral conquest",
      treasure: "author manually scatters 240 by default; arrival on the exact cell claims one; re-scatter replaces unclaimed positions",
      cultivationPower: "linear interpolation from powerGainPctMin to powerGainPctMax using the chosen gold within its attempt range",
      cultivationTalent: "one chosen material; talent progress only, no combat-power change"
    },
    availability: {
      observedGeneralChancePctPerVictoriousConquest: round2(sumBy(playerRecords, player => player.discovery.generals) / Math.max(1, totalWins) * 100),
      expectedGeneralsTotal: round2(sumBy(playerRecords, player => player.discovery.expectedGenerals)),
      expectedGeneralsPerPlayer: round2(sumBy(playerRecords, player => player.discovery.expectedGenerals) / players),
      generalChancePctRangePerVictoriousConquest: { min: 2, max: 25 },
      treasureClaimedTotal: sumBy(playerRecords, player => player.discovery.treasures),
      treasureSupplyTotal: BALANCE_BASELINE.treasureScatter.count
    }
  };
}

module.exports = { runSimulation, CULTIVATION_RANGES, BALANCE_BASELINE, PROPOSED_MINING_BALANCE, TALENT_POTENCY, TALENT_CAPS };

if (require.main === module) {
  const result = runSimulation();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
