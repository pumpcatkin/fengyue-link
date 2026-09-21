import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");
const talentEngine = require("../electron/grid-talents.cjs");

function joined(now = 1_000_000) {
  const base = game.createWorld({ seed: "cultivation-seed", seasonId: "season", startedAt: now, authorityAccountId: "a" });
  return game.applyIntent(base, {
    type: "join", orientation: "women", displayName: "甲", characterProfileId: "profile-a",
    characterTags: ["沉稳"], initialGeneralWish: "一名可靠的良将", idempotencyKey: "join-a"
  }, { actorAccountId: "a", now }).state;
}

function grant(state: any, now: number, id = "general") {
  return game.applyIntent(state, {
    type: "grant-general", generalId: id, name: "青禾", gender: "female", setting: "善守城。",
    power: 500, discoveryId: id, idempotencyKey: `grant-${id}`
  }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
}

function adjacent(position: any) {
  return { x: position.x === 63 ? 62 : position.x + 1, y: position.y };
}

describe("grid cultivation and integrated talents", () => {
  it.each([0, 1, 2, 3, 4])("scales stage %i from five to one hundred percent before stable 0.5-1.5 variation", count => {
    const state = grant(joined(), 1_000_000, "range");
    const general = state.generals.range;
    general.cultivationCount = count;
    const range = game.CULTIVATION_RANGES[count];
    const options = { seed: "range" };
    const low = game.cultivationQuote(general, state.players.a, 1_000_000, { ...options, goldInvestment: range.goldMin });
    const high = game.cultivationQuote(general, state.players.a, 1_000_000, { ...options, goldInvestment: range.goldMax });
    const middle = game.cultivationQuote(general, state.players.a, 1_000_000, { ...options, goldInvestment: (range.goldMin + range.goldMax) / 2 });
    expect(low.basePowerGainPercent).toBe(5);
    expect(high.basePowerGainPercent).toBe(100);
    expect(middle.basePowerGainPercent).toBe(52.5);
    expect(low.randomFactor).toBe(high.randomFactor);
    expect(low.randomFactor).toBeGreaterThanOrEqual(0.5);
    expect(high.randomFactor).toBeLessThanOrEqual(1.5);
    expect(high.powerGain).toBeGreaterThan(middle.powerGain);
    expect(middle.powerGain).toBeGreaterThan(low.powerGain);
  });

  it.each([0, 1, 2, 3, 4])("uses the same five-to-one-hundred-percent range for player stage %i", count => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    player.cultivationCount = count;
    player.gold = 2_000_000;
    const range = game.CULTIVATION_RANGES[count];
    const minimum = range.goldMin * game.PLAYER_CULTIVATION_GOLD_MULTIPLIER;
    const maximum = range.goldMax * game.PLAYER_CULTIVATION_GOLD_MULTIPLIER;
    const investments: [number, number][] = [[minimum, 5], [(minimum + maximum) / 2, 52.5], [maximum, 100]];
    for (const [goldInvestment, expectedPercent] of investments) {
      const result = game.applyIntent(state, { type: "cultivate-player", goldInvestment, idempotencyKey: `player-range-${count}-${goldInvestment}` }, { actorAccountId: "a", now });
      expect(result.result.basePowerGainPercent).toBe(expectedPercent);
      expect(result.result.randomFactor).toBeGreaterThanOrEqual(0.5);
      expect(result.result.randomFactor).toBeLessThanOrEqual(1.5);
      expect(result.result.cost).toBe(goldInvestment);
      expect(result.state.players.a.gold).toBe(2_000_000 - goldInvestment);
      expect(result.state.players.a.power).toBeGreaterThan(player.power);
    }
  });

  it.each(["waiting", "market", "deployed", "captured"])("rejects a %s general even when experience and budget are sufficient", status => {
    const state = grant(joined(), 1_000_000, "not-carried");
    state.players.a.gold = 100_000;
    state.privatePlayers.a.materials.white = 1;
    state.generals["not-carried"].experience = 100;
    state.generals["not-carried"].status = status;
    const before = structuredClone(state);
    expect(() => game.applyIntent(state, {
      type: "cultivate-general", generalId: "not-carried", goldInvestment: 8000, materialId: "white", idempotencyKey: status
    }, { actorAccountId: "a", now: 1_000_000 })).toThrow();
    expect(state).toEqual(before);
    expect(game.projectWorldState(state, "a", 1_000_000).generals["not-carried"].cultivationQuote.eligible).toBe(false);
  });

  it("projects numeric experience without changing the stored fractional progress", () => {
    const state = grant(joined(), 1_000_000, "xp");
    state.generals.xp.experience = 24.659;
    delete state.generals.xp.experienceRequired;
    const projection = game.projectWorldState(state, "a", 1_000_000);
    expect(projection.generals.xp).toMatchObject({ experience: 24.659, experienceRequired: 100 });
    expect(state.generals.xp.experience).toBe(24.659);
    state.generals.xp.cultivationCount = 5;
    expect(game.projectWorldState(state, "a").generals.xp).toMatchObject({ experience: 0, experienceRequired: 0 });
  });

  it("uses fixed ten-minute runs for every resource grade without hourly rank inversions", () => {
    const population = 4000;
    let previousHourly = 0;
    for (let resourceRank = 0; resourceRank < game.RESOURCE_GRADES.length; resourceRank += 1) {
      const cell = { population, resourceRank };
      const cycleMs = game.resourceCycleMs(cell);
      expect(cycleMs).toBe(10 * game.MINUTE);
      const yieldPerCycle = game.resourceYield(cell);
      const expected = Math.max(1, Math.round((400 + population * 0.09) * (1 + resourceRank * 0.08)
        * game.MINING_GRADE_YIELD_MULTIPLIERS[resourceRank] * cycleMs / game.HOUR));
      const legacy = Math.max(1, Math.round((400 + population * 0.09) * (1 + resourceRank * 0.08) * cycleMs / game.HOUR));
      const hourly = yieldPerCycle * game.HOUR / cycleMs;
      expect(yieldPerCycle).toBe(expected);
      // Integer rounding can leave the displayed run one coin below an exact
      // rounded 2.8x threshold; compare the underlying ratio with that bound.
      expect(yieldPerCycle).toBeGreaterThanOrEqual(legacy * 2.8 - 1);
      expect(hourly).toBeGreaterThan(previousHourly);
      previousHourly = hourly;
    }
  });

  it("settles elapsed legacy mining cycles once and then starts the new cooldown", () => {
    const now = 1_000_000;
    let state = joined(now);
    const position = state.players.a.position;
    const started = game.applyIntent(state, { type: "start-mining", x: position.x, y: position.y, auto: true, idempotencyKey: "legacy-rate" }, { actorAccountId: "a", now });
    state = started.state;
    const job = state.jobs[started.result.jobId];
    const oldYield = 2;
    job.yieldPerCycle = oldYield;
    delete job.yieldFormulaVersion;
    const before = state.players.a.gold;
    const first = game.settleWorld(state, now + job.cycleMs * 3);
    expect(first.state.players.a.gold).toBe(before + oldYield * 3);
    expect(first.state.jobs[job.id]).toBeUndefined();
    expect(first.state.privatePlayers.a.miningCooldowns[`${position.x},${position.y}`]).toBeGreaterThan(now + job.cycleMs * 3);
  });

  it("migrates every general to exactly one deterministic talent", () => {
    const legacy: any = { id: "legacy", gender: "female", setting: "旧将。", power: 500 };
    game.ensureGeneralProfile(legacy);
    expect(legacy.talent).toEqual(game.ensureGeneralProfile(structuredClone(legacy)).talent);
    expect(talentEngine.TALENT_BY_ID[legacy.talent.talentId]).toBeTruthy();
    expect(legacy.cultivationCount).toBe(0);
    expect(game.generalTalentState(legacy).description).toMatch(/%/);
  });

  it("opens the first general cultivation immediately with one material and an instant result", () => {
    const joinedAt = 1_000_000;
    let state = grant(joined(joinedAt), joinedAt, "cultivator");
    state.players.a.gold = 20_000;
    expect(state.privatePlayers.a.materials.white).toBe(0);
    state.privatePlayers.a.materials.white = 1;
    state.generals.cultivator.experience = game.generalExperienceRequirement(state.generals.cultivator);
    const before = state.generals.cultivator.power;
    const cultivated = game.applyIntent(state, {
      type: "cultivate-general", generalId: "cultivator", goldInvestment: 8000, materialId: "white", idempotencyKey: "cultivate-1"
    }, { actorAccountId: "a", now: joinedAt });
    expect(cultivated.result.durationMs).toBe(0);
    expect(cultivated.result.goldInvestment).toBe(8000);
    expect(cultivated.result.basePowerGainPercent).toBe(100);
    expect(cultivated.result.randomFactor).toBeGreaterThanOrEqual(0.5);
    expect(cultivated.result.randomFactor).toBeLessThanOrEqual(1.5);
    expect(cultivated.result.powerGainPercent).toBeGreaterThanOrEqual(50);
    expect(cultivated.result.powerGainPercent).toBeLessThanOrEqual(150);
    expect(cultivated.state.jobs).toEqual({});
    expect(cultivated.state.privatePlayers.a.materials.white).toBe(0);
    expect(cultivated.state.generals.cultivator.cultivationCount).toBe(1);
    expect(cultivated.state.generals.cultivator.power).toBeGreaterThan(before);
    expect(cultivated.state.generals.cultivator.talent.progress).toBeGreaterThan(state.generals.cultivator.talent.progress);
  });

  it("gives a meaningful first-cultivation gain for a 1500 gold investment", () => {
    const now = 1_000_000;
    const state = grant(joined(now), now, "cultivator-1500");
    state.players.a.gold = 10_000;
    state.privatePlayers.a.materials.white = 1;
    state.generals["cultivator-1500"].experience = game.generalExperienceRequirement(state.generals["cultivator-1500"]);
    const before = state.generals["cultivator-1500"].power;
    const cultivated = game.applyIntent(state, {
      type: "cultivate-general", generalId: "cultivator-1500", goldInvestment: 1500, materialId: "white", idempotencyKey: "cultivate-1500"
    }, { actorAccountId: "a", now });
    expect(cultivated.state.generals["cultivator-1500"].power - before).toBeGreaterThanOrEqual(7);
    expect(cultivated.state.players.a.gold).toBe(8500);
  });

  it.each([0, 1, 2, 3, 4])("requires full experience at cultivation stage %i and resets it after one attempt", count => {
    const now = 1_000_000;
    const state = grant(joined(now), now, "experience-gate");
    const general = state.generals["experience-gate"];
    general.cultivationCount = count;
    const required = game.generalExperienceRequirement(general);
    state.players.a.gold = 1_000_000;
    state.privatePlayers.a.materials.white = 6;
    const intent = {
      type: "cultivate-general", generalId: general.id, goldInvestment: game.CULTIVATION_RANGES[count].goldMin + 137,
      materialId: "white", idempotencyKey: `xp-${count}`
    };
    for (const experience of [undefined, 0, -1, NaN, Infinity, required - 1, required - 0.0001]) {
      general.experience = experience;
      expect(() => game.applyIntent(state, intent, { actorAccountId: "a", now })).toThrow(/经验不足/);
      expect(state.players.a.gold).toBe(1_000_000);
      expect(state.privatePlayers.a.materials.white).toBe(6);
    }
    general.experience = required;
    const cultivated = game.applyIntent(state, intent, { actorAccountId: "a", now });
    expect(cultivated.state.players.a.gold).toBe(1_000_000 - intent.goldInvestment);
    expect(cultivated.result.cost).toBe(intent.goldInvestment);
    expect(cultivated.state.generals[general.id]).toMatchObject({ cultivationCount: count + 1, experience: 0 });
    if (count < 4) {
      expect(() => game.applyIntent(cultivated.state, {
        ...intent, goldInvestment: game.CULTIVATION_RANGES[count + 1].goldMin, idempotencyKey: `again-${count}`
      }, { actorAccountId: "a", now })).toThrow(/经验不足/);
    }
  });

  it.each([1500, 5000, 8000])("spends precisely %i submitted gold even with a cultivation discount talent", goldInvestment => {
    const now = 1_000_000;
    const state = grant(joined(now), now, "budget");
    state.players.a.gold = 100_000;
    state.privatePlayers.a.materials.white = 1;
    state.generals.budget.experience = 100;
    state.generals.budget.talent = talentEngine.normalizeTalent({ instanceId: "budget", talentId: "simple-retreat", progress: 1000 });
    const result = game.applyIntent(state, {
      type: "cultivate-general", generalId: "budget", goldInvestment, materialId: "white", idempotencyKey: "budget"
    }, { actorAccountId: "a", now });
    expect(result.result.modifiers.cultivationCost).toBeLessThan(0);
    expect(result.result.cost).toBe(goldInvestment);
    expect(result.state.players.a.gold).toBe(100_000 - goldInvestment);
    const player = game.applyIntent(state, { type: "cultivate-player", goldInvestment, idempotencyKey: "player-budget" }, { actorAccountId: "a", now });
    expect(player.result.cost).toBe(goldInvestment);
    expect(player.state.players.a.gold).toBe(100_000 - goldInvestment);
  });

  it("rejects missing or invalid submitted budgets instead of substituting a default", () => {
    const now = 1_000_000;
    const state = grant(joined(now), now, "invalid-budget");
    state.players.a.gold = 100_000;
    state.privatePlayers.a.materials.white = 1;
    state.generals["invalid-budget"].experience = 100;
    for (const goldInvestment of [undefined, null, "", 0, 1499.5, Infinity, NaN]) {
      expect(() => game.applyIntent(state, {
        type: "cultivate-general", generalId: "invalid-budget", goldInvestment, materialId: "white", idempotencyKey: "invalid"
      }, { actorAccountId: "a", now })).toThrow(/修炼投入/);
    }
  });

  it("uses the same five-attempt gold model for the player without consuming materials", () => {
    const joinedAt = 1_000_000;
    const state = joined(joinedAt);
    state.players.a.gold = 20_000;
    state.privatePlayers.a.materials.white = 3;
    const beforePower = state.players.a.power;
    const cultivated = game.applyIntent(state, {
      type: "cultivate-player", goldInvestment: 12500, materialId: "white", idempotencyKey: "player-cultivate-1"
    }, { actorAccountId: "a", now: joinedAt });
    expect(cultivated.result).toMatchObject({ targetType: "player", materialId: null, materialCount: 0, durationMs: 0, cultivationCount: 1 });
    expect(cultivated.state.players.a.gold).toBe(7_500);
    expect(cultivated.state.players.a.power).toBeGreaterThan(beforePower);
    expect(cultivated.state.privatePlayers.a.materials.white).toBe(3);
    expect(cultivated.state.jobs).toEqual({});
  });

  it("does not gate the first player or general cultivation by join duration", () => {
    const joinedAt = 1_000_000;
    const state = grant(joined(joinedAt), joinedAt, "instant-gate-check");
    state.players.a.gold = 20_000;
    state.privatePlayers.a.materials.white = 1;
    const playerQuote = game.cultivationQuote(state.players.a, state.players.a, joinedAt, { state, targetType: "player", goldInvestment: 12500 });
    state.generals["instant-gate-check"].experience = game.generalExperienceRequirement(state.generals["instant-gate-check"]);
    const generalQuote = game.cultivationQuote(state.generals["instant-gate-check"], state.players.a, joinedAt, { state, goldInvestment: 5000, materialId: "white" });
    expect(playerQuote).toMatchObject({ attempt: 1, gateHours: 0, unlocked: true });
    expect(generalQuote).toMatchObject({ attempt: 1, gateHours: 0, unlocked: true });
  });

  it("keeps later cultivation intervals while allowing the first attempt immediately", () => {
    expect(game.CULTIVATION_RANGES.map((range: any) => range.gateHours)).toEqual([0, 0, 0, 0, 0]);
    const now = 1_000_000;
    const state = grant(joined(now), now, "interval-check");
    state.generals["interval-check"].cultivationCount = 1;
    state.generals["interval-check"].experience = game.generalExperienceRequirement(state.generals["interval-check"]);
    const quote = game.cultivationQuote(state.generals["interval-check"], state.players.a, now, { state, goldInvestment: 12000, materialId: "white" });
    expect(quote.unlocked).toBe(true);
    expect(quote.unlockAt).toBe(0);
  });

  it("keeps cultivation fluctuation stable across repeated previews", () => {
    const now = 1_000_000;
    const state = grant(joined(now), now, "stable-roll");
    const general = state.generals["stable-roll"];
    const player = state.players.a;
    const first = game.cultivationQuote(general, player, now + 6 * game.HOUR, { state, goldInvestment: 6500, materialId: "white" });
    const second = game.cultivationQuote(general, player, now + 7 * game.HOUR, { state, goldInvestment: 6500, materialId: "white" });
    expect(second.randomFactor).toBe(first.randomFactor);
    expect(second.powerGain).toBe(first.powerGain);
    const otherState = structuredClone(state);
    otherState.seed = "another-world";
    const other = game.cultivationQuote(otherState.generals["stable-roll"], otherState.players.a, now + 7 * game.HOUR, { state: otherState, goldInvestment: 6500, materialId: "white" });
    expect(other.randomFactor).not.toBe(first.randomFactor);
  });

  it("enforces undeployed, non-captive, five-attempt cultivation", () => {
    const now = 1_000_000;
    let state = grant(joined(now), now, "five");
    state.players.a.gold = 2_000_000;
    state.privatePlayers.a.materials.white = 6;
    const late = now + 600 * game.HOUR;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const range = game.CULTIVATION_RANGES[attempt - 1];
      state.generals.five.experience = game.generalExperienceRequirement(state.generals.five);
      state = game.applyIntent(state, {
        type: "cultivate-general", generalId: "five", goldInvestment: range.goldMin,
        materialId: "white", idempotencyKey: `five-${attempt}`
      }, { actorAccountId: "a", now: late + attempt }).state;
    }
    expect(state.generals.five.cultivationCount).toBe(5);
    expect(() => game.applyIntent(state, {
      type: "cultivate-general", generalId: "five", goldInvestment: 160000,
      materialId: "white", idempotencyKey: "sixth"
    }, { actorAccountId: "a", now: late + 10 })).toThrow(/五次/);

    let deployed = grant(joined(now), now, "deployed");
    deployed.players.a.gold = 20_000;
    deployed = game.applyIntent(deployed, { type: "deploy-general", generalId: "deployed", idempotencyKey: "deploy" }, { actorAccountId: "a", now: now + 1 }).state;
    expect(() => game.applyIntent(deployed, {
      type: "cultivate-general", generalId: "deployed", goldInvestment: 5000,
      materialId: "white", idempotencyKey: "deployed-cultivate"
    }, { actorAccountId: "a", now: now + 6 * game.HOUR })).toThrow(/部署/);
  });

  it("closes the legacy general power-training bypass but settles an existing legacy job", () => {
    const now = 1_000_000;
    let state = grant(joined(now), now, "legacy-training");
    state.players.a.gold = 100_000;
    expect(() => game.applyIntent(state, {
      type: "power-train", targetType: "general", targetId: "legacy-training", levels: 1, idempotencyKey: "blocked-general-power"
    }, { actorAccountId: "a", now: now + 1 })).toThrow(/五次天赋修炼/);
    const general = state.generals["legacy-training"];
    state.jobs.legacy = {
      id: "legacy", type: "power-training", accountId: "a", targetType: "general", targetId: "legacy-training",
      levels: 1, fromLevel: 0, toLevel: 1, basePower: general.basePower, cost: 100, startedAt: now, finishAt: now + 1
    };
    state = game.settleWorld(state, now + 1).state;
    expect(state.generals["legacy-training"].trainingLevel).toBe(1);
    expect(state.jobs.legacy).toBeUndefined();
  });

  it("uses 30 seconds per cell and applies selected carried talents to march quotes", () => {
    expect(game.marchDurationMs(126)).toBe(126 * 15_000);
    const now = 1_000_000;
    let state = grant(joined(now), now, "runner");
    const target = adjacent(state.players.a.position);
    state.generals.runner.talent = talentEngine.normalizeTalent({ instanceId: "runner", talentId: "swift-column", progress: 1000 });
    state.players.a.fieldArmySoldiers = 1;
    const quote = game.marchQuote(state, "a", target, 1, ["runner"], false, now + 1);
    expect(quote.baseDurationMs).toBe(15_000);
    expect(quote.durationMs).toBe(Math.round(15_000 * (1 + quote.modifiers.marchDuration)));
    const march = game.applyIntent(state, {
      type: "march", to: target, soldiers: 1, generalIds: ["runner"], attack: false, idempotencyKey: "talented-march"
    }, { actorAccountId: "a", now: now + 1 });
    expect(march.result.durationMs).toBe(quote.durationMs);
    expect(march.state.jobs[march.result.jobId].finishAt).toBe(now + 1 + quote.durationMs);
  });

  it("carries every general while only the first two ordered slots affect a march", () => {
    const now = 1_000_000;
    let state = joined(now);
    state = grant(state, now, "first");
    state = grant(state, now, "second");
    state = grant(state, now, "third");
    expect(state.players.a.carriedGeneralIds).toEqual(expect.arrayContaining(["first", "second", "third"]));
    expect(state.players.a.carriedGeneralIds).toHaveLength(3);

    const reordered = game.applyIntent(state, {
      type: "reorder-carried-generals", generalIds: ["third", "first", "second"], idempotencyKey: "reorder-three"
    }, { actorAccountId: "a", now: now + 1 });
    expect(reordered.result).toEqual({ generalIds: ["third", "first", "second"], activeGeneralIds: ["third", "first"] });

    const target = adjacent(reordered.state.players.a.position);
    const march = game.applyIntent(reordered.state, {
      type: "march", to: target, soldiers: 0, generalIds: ["second"], attack: false, idempotencyKey: "all-generals-march"
    }, { actorAccountId: "a", now: now + 2 });
    const job = march.state.jobs[march.result.jobId];
    expect(job.generalIds).toEqual(["third", "first", "second"]);
    expect(job.activeGeneralIds).toEqual(["third", "first"]);
    expect(march.result.activeGeneralIds).toEqual(["third", "first"]);
  });

  it("applies talent modifiers to mining, troop training, and combat", () => {
    const now = 1_000_000;
    let state = grant(joined(now), now, "worker");
    const position = state.players.a.position;
    const info = game.staticCell(state.seed, position.x, position.y);
    state.generals.worker.talent = talentEngine.normalizeTalent({ instanceId: "worker", talentId: "ore-sense", progress: 1000 });
    state = game.applyIntent(state, { type: "deploy-general", generalId: "worker", idempotencyKey: "deploy-worker" }, { actorAccountId: "a", now }).state;
    const mining = game.applyIntent(state, { type: "start-mining", x: position.x, y: position.y, auto: true, idempotencyKey: "talented-mine" }, { actorAccountId: "a", now: now + 1 });
    expect(mining.result.yieldPerCycle).toBeGreaterThan(game.resourceYield(info));

    state = grant(joined(now), now, "trainer");
    state.players.a.gold = 100_000;
    const trainingPosition = state.players.a.position;
    state.generals.trainer.talent = talentEngine.normalizeTalent({ instanceId: "trainer", talentId: "recruiting-office", progress: 1000 });
    state = game.applyIntent(state, { type: "deploy-general", generalId: "trainer", idempotencyKey: "deploy-trainer" }, { actorAccountId: "a", now }).state;
    const training = game.applyIntent(state, { type: "train", x: trainingPosition.x, y: trainingPosition.y, amount: 10, idempotencyKey: "talented-train" }, { actorAccountId: "a", now: now + 1 });
    expect(training.result.outputAmount).toBeGreaterThan(10);

    state = grant(joined(now), now, "fighter");
    state.players.a.gold = 100_000;
    state.generals.fighter.talent = talentEngine.normalizeTalent({ instanceId: "fighter", talentId: "spearhead", progress: 1000 });
    const combatTarget = adjacent(state.players.a.position);
    state.players.a.fieldArmySoldiers = game.staticCell(state.seed, combatTarget.x, combatTarget.y).neutralPower + 100;
    const combat = game.applyIntent(state, { type: "march", to: combatTarget, soldiers: state.players.a.fieldArmySoldiers, generalIds: ["fighter"], attack: true, idempotencyKey: "talented-combat" }, { actorAccountId: "a", now });
    const settled = game.settleWorld(combat.state, combat.result.finishAt);
    const battle = settled.effects.find((effect: any) => effect.type === "battle-won");
    expect(battle.attackModifiers.attackPower).toBeGreaterThan(0);
  });

  it("applies mining-duration talents to the authoritative job timer", () => {
    const now = 1_000_000;
    let state = grant(joined(now), now, "miner-clock");
    const position = state.players.a.position;
    const baseDuration = game.resourceCycleMs(game.staticCell(state.seed, position.x, position.y));
    state.generals["miner-clock"].talent = talentEngine.normalizeTalent({
      instanceId: "miner-clock", talentId: "shift-bells", progress: 1000
    });
    state = game.applyIntent(state, {
      type: "deploy-general", generalId: "miner-clock", idempotencyKey: "deploy-miner-clock"
    }, { actorAccountId: "a", now }).state;
    const mining = game.applyIntent(state, {
      type: "start-mining", x: position.x, y: position.y, idempotencyKey: "timed-mine"
    }, { actorAccountId: "a", now: now + 1 });
    expect(mining.result.modifiers.miningDuration).toBeLessThan(0);
    expect(mining.result.durationMs).toBeLessThan(baseDuration);
    expect(mining.state.jobs[mining.result.jobId].finishAt).toBe(now + 1 + mining.result.durationMs);
  });

  it("applies hostile adjacent deployed talents as bounded debuffs without leaking enemy buffs", () => {
    const now = 1_000_000;
    let state = joined(now);
    const position = state.players.a.position;
    const enemyPosition = adjacent(position);
    const enemy = game.createFallbackGeneral({ id: "enemy", name: "敌将", gender: "female", power: 500, holderAccountId: "b", talentSeed: state.seed });
    enemy.status = "deployed";
    enemy.location = enemyPosition;
    enemy.talent = talentEngine.normalizeTalent({ instanceId: "enemy", talentId: "frontier-salvage", progress: 1000 });
    expect(talentEngine.describeTalent(enemy.talent)).toContain("削弱敌方相邻8格");
    state.generals.enemy = enemy;
    state.cells[`${enemyPosition.x},${enemyPosition.y}`] = { ownerAccountId: "b", soldiers: 1, generalIds: ["enemy"] };
    const baseYield = game.resourceYield(game.staticCell(state.seed, position.x, position.y));
    const mining = game.applyIntent(state, { type: "start-mining", x: position.x, y: position.y, auto: true, idempotencyKey: "enemy-debuff-mine" }, { actorAccountId: "a", now: now + 1 });
    expect(mining.result.modifiers.miningYield).toBeLessThan(0);
    expect(mining.result.yieldPerCycle).toBeLessThan(baseYield);
    expect(mining.result.modifiers.applied).toContainEqual(expect.objectContaining({ generalId: "enemy", enemyDebuff: true }));
  });

  it("claims a public treasure only after occupying its cell", () => {
    const now = 1_000_000;
    let state = joined(now);
    const target = adjacent(state.players.a.position);
    state.treasureSpawns = { cache: { id: "cache", epoch: 1, x: target.x, y: target.y, materialId: "blue", spawnedAt: now } };
    state.treasureEpoch = 1;
    const before = state.privatePlayers.a.materials.blue;
    const march = game.applyIntent(state, { type: "march", to: target, soldiers: 0, generalIds: [], attack: false, idempotencyKey: "treasure-march" }, { actorAccountId: "a", now });
    state = game.settleWorld(march.state, march.result.finishAt).state;
    expect(state.privatePlayers.a.materials.blue).toBe(before);
    expect(state.treasureSpawns.cache).toBeTruthy();

    const capital = Object.values(state.cells).find((cell: any) => cell.ownerAccountId === "a") as any;
    const capitalKey = Object.entries(state.cells).find(([, cell]: any) => cell === capital)?.[0] || "";
    const [capitalX, capitalY] = capitalKey.split(",").map(Number);
    const returned = game.applyIntent(state, { type: "march", to: { x: capitalX, y: capitalY }, soldiers: 0, attack: false, idempotencyKey: "treasure-return" }, { actorAccountId: "a", now: march.result.finishAt });
    state = game.settleWorld(returned.state, returned.result.finishAt).state;
    const force = game.staticCell(state.seed, target.x, target.y).neutralPower + 10_000;
    state.players.a.fieldArmySoldiers = force;
    state.players.a.gold = game.marchCost(1, force, state.players.a.carriedGeneralIds.length) + 100;
    const conquest = game.applyIntent(state, { type: "march", to: target, soldiers: force, attack: true, idempotencyKey: "treasure-conquest" }, { actorAccountId: "a", now: returned.result.finishAt });
    state = game.settleWorld(conquest.state, conquest.result.finishAt).state;
    expect(state.privatePlayers.a.materials.blue).toBe(before + 1);
    expect(state.treasureSpawns.cache).toBeUndefined();
    expect(state.claimedTreasures.cache).toMatchObject({ accountId: "a", x: target.x, y: target.y });
    const projection = game.projectWorldState(state, "a", conquest.result.finishAt);
    expect(projection.players.a.materials.blue).toBe(before + 1);
    expect(projection.claimedTreasures.cache).toBeTruthy();
  });

  it("lets the host explicitly scatter treasures while controlling every red drop", () => {
    const now = 1_000_000;
    const state = joined(now);
    const idle = game.settleWorld(state, now + 30 * 24 * game.HOUR).state;
    expect(idle.treasureSpawns).toEqual({});
    const scattered = game.scatterTreasures(idle, { count: 20, redAscend: 2, redReroll: 1 }, now + 1);
    expect(Object.keys(scattered.active)).toHaveLength(20);
    expect(Object.values(scattered.active).filter((item: any) => item.materialId === "red-ascend")).toHaveLength(2);
    expect(Object.values(scattered.active).filter((item: any) => item.materialId === "red-reroll")).toHaveLength(1);
    for (const item of Object.values(scattered.active) as any[]) {
      expect(idle.cells[`${item.x},${item.y}`]?.ownerAccountId).toBeFalsy();
    }
    game.scatterTreasures(idle, { count: 20 }, now + 2);
    expect(Object.values(idle.treasureSpawns).some((item: any) => item.materialId.startsWith("red-"))).toBe(false);
    expect(idle.treasureEpoch).toBe(2);
  });

  it("projects authoritative summaries and sends complete power/history context to dialogue", () => {
    const now = 1_000_000;
    let state = grant(joined(now), now, "speaker");
    const general = state.generals.speaker;
    general.masterHistory.push({ accountId: "former", fromYear: 2, toYear: 3, reason: "旧主" });
    general.captivityHistory.push({ captorAccountId: "a", formerMasterAccountId: "former", year: 3 });
    general.interactionHistory.push({ year: 3, speakerName: "旧主", summary: "旧事", userText: "问", reply: "答" });
    const request = game.buildGeneralDialogueRequest(state, general, state.players.a, "近况", now + 1);
    expect(request.input.general.power).toBe(general.power);
    expect(request.input.general.talent.summary.text).toMatch(/%/);
    expect(request.input.general.masterHistory).toHaveLength(2);
    expect(request.input.general.captivityHistory).toHaveLength(1);
    expect(request.input.general.recentInteractions).toHaveLength(1);
    expect(request.input.speaker.power).toBe(state.players.a.power);
    expect(request.input.speaker.deployedGeneralAveragePower).toBe(0);

    const projection = game.projectWorldState(state, "a", now + 6 * game.HOUR);
    expect(projection.generals.speaker.talentSummary).toMatchObject({ name: expect.any(String), rarity: expect.any(String), text: expect.any(String) });
    expect(projection.generals.speaker.cultivationQuote).toMatchObject({ attempt: 1, durationMs: 0, remaining: 5, unlocked: true });
    expect(projection.players.a.marchModifiers).toEqual(expect.objectContaining({ durationMultiplier: expect.any(Number), costMultiplier: expect.any(Number) }));
  });

  it("keeps the complete master chain in model and public general projections", () => {
    const now = 1_000_000;
    const state = grant(joined(now), now, "long-history");
    const general = state.generals["long-history"];
    general.masterHistory = Array.from({ length: 25 }, (_, index) => ({ accountId: `lord-${index}`, fromYear: index + 1, toYear: index + 2, reason: `第${index + 1}任` }));
    const request = game.buildGeneralDialogueRequest(state, general, state.players.a, "历任主公", now);
    expect(request.input.general.masterHistory).toHaveLength(25);
    general.status = "deployed";
    general.location = state.players.a.position;
    expect(game.publicGeneralState(general).masterHistory).toHaveLength(25);
  });

  it("projects talent-adjusted defensive power and global opposing deployed average", () => {
    const now = 1_000_000;
    let state = grant(joined(now), now, "speaker-global");
    const position = state.players.a.position;
    const enemyPosition = adjacent(position);
    const enemy = game.createFallbackGeneral({ id: "global-enemy", name: "外部守将", gender: "female", power: 900, holderAccountId: "b", talentSeed: state.seed });
    enemy.status = "deployed";
    enemy.location = enemyPosition;
    enemy.talent = talentEngine.normalizeTalent({ instanceId: "global-enemy", talentId: "garrison-command", progress: 1000 });
    state.generals[enemy.id] = enemy;
    state.players.b = { accountId: "b", displayName: "乙", power: 500, position: enemyPosition, carriedGeneralIds: [] };
    state.cells[`${enemyPosition.x},${enemyPosition.y}`] = { ownerAccountId: "b", soldiers: 100, generalIds: [enemy.id] };
    const own = game.createFallbackGeneral({ id: "global-own", name: "本方守将", gender: "female", power: 500, holderAccountId: "a", talentSeed: state.seed });
    own.status = "deployed";
    own.location = position;
    state.generals[own.id] = own;
    state.cells[`${position.x},${position.y}`].generalIds = [own.id];
    const request = game.buildGeneralDialogueRequest(state, state.generals["speaker-global"], state.players.a, "战局", now);
    expect(request.input.speaker.deployedGeneralAveragePower).toBe(700);
    expect(request.input.speaker.opposingDeployedGeneralAveragePower).toBe(enemy.power);
    const projection = game.projectWorldState(state, "a", now);
    const projectedCell = projection.cells[`${enemyPosition.x},${enemyPosition.y}`];
    expect(projectedCell.defensivePower).toBeGreaterThan(100 + enemy.power);
  });
});
