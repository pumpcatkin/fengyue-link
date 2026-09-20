import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");
const talents = require("../electron/grid-talents.cjs");
const { OnlineWorldService } = require("../electron/online-world-service.cjs");

const NOW = 1_000_000;

function joined(seed = "progression-seed", now = NOW) {
  const base = game.createWorld({ seed, seasonId: "season", startedAt: now, authorityAccountId: "a" });
  return game.applyIntent(base, {
    type: "join", orientation: "women", displayName: "甲", characterProfileId: "profile-a",
    characterTags: ["沉稳"], initialGeneralWish: "一名可靠的良将", idempotencyKey: `join-${seed}`
  }, { actorAccountId: "a", now }).state;
}

function grant(state: any, id = "general", now = NOW) {
  return game.applyIntent(state, {
    type: "grant-general", generalId: id, name: "青禾", gender: "female", setting: "善守城。",
    power: 300, discoveryId: id, idempotencyKey: `grant-${id}`
  }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
}

function deploy(state: any, id = "general", now = NOW) {
  return game.applyIntent(state, { type: "deploy-general", generalId: id, idempotencyKey: `deploy-${id}` }, {
    actorAccountId: "a", now
  }).state;
}

describe("grid progression update rules", () => {
  it("increases every mining grade by at least 2.8x while retaining grade ordering", () => {
    const population = 4_000;
    let previous = 0;
    for (let rank = 0; rank < game.RESOURCE_GRADES.length; rank += 1) {
      const cell = { population, populationBase: population, resourceMultiplier: 1, resourceRank: rank };
      const legacy = Math.max(1, Math.round((400 + population * 0.09) * (1 + rank * 0.08) * 10 / 60));
      const current = game.resourceYield(cell);
      expect(current).toBeGreaterThanOrEqual(legacy * 2.8 - 1);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(game.MINING_GRADE_YIELD_MULTIPLIERS[0]).toBe(2.8);
    expect(game.MINING_GRADE_YIELD_MULTIPLIERS.at(-1)).toBe(5.32);
  });

  it("uses 15 seconds per cell and the requested march cost increments", () => {
    expect(game.MARCH_MS_PER_CELL).toBe(15_000);
    expect(game.marchDurationMs(8)).toBe(120_000);
    expect(game.marchCost(1, 0, 0)).toBe(1);
    expect(game.marchCost(1, 10, 0)).toBe(2);
    expect(game.marchCost(1, 11, 0)).toBe(3);
    expect(game.marchCost(1, 11, 2)).toBe(7);
  });

  it("requires general experience, but lets the player cultivate with 2.5x gold and 10% lower gain", () => {
    let state = grant(joined(), "cultivator");
    const general = state.generals.cultivator;
    const player = state.players.a;
    const required = game.generalExperienceRequirement(general);
    expect(required).toBe(100);
    expect(game.cultivationQuote(general, player, NOW, { state, goldInvestment: 5_000, materialId: "white" })).toMatchObject({
      experience: 0, experienceRequired: 100, experienceReady: false
    });
    state.privatePlayers.a.materials.white = 2;
    expect(() => game.applyIntent(state, {
      type: "cultivate-general", generalId: "cultivator", goldInvestment: 5_000, materialId: "white", idempotencyKey: "blocked"
    }, { actorAccountId: "a", now: NOW })).toThrow(/经验不足/);

    general.experience = required;
    const generalQuote = game.cultivationQuote(general, player, NOW, { state, goldInvestment: 5_000, materialId: "white" });
    const playerQuote = game.cultivationQuote(player, player, NOW, { state, targetType: "player", goldInvestment: 12_500 });
    expect(generalQuote.experienceReady).toBe(true);
    expect(playerQuote.goldMin).toBe(Math.ceil(game.CULTIVATION_RANGES[0].goldMin * 2.5));
    expect(playerQuote.goldMax).toBe(Math.ceil(game.CULTIVATION_RANGES[0].goldMax * 2.5));
    expect(playerQuote.basePowerGainPercent).toBeCloseTo(generalQuote.basePowerGainPercent * 0.9, 2);
    expect(playerQuote.materialCount).toBe(0);
  });

  it("accrues deployed experience at idle and training rates without stacking", () => {
    let idle = deploy(grant(joined(), "idle"), "idle");
    idle.generals.idle.experienceUpdatedAt = NOW;
    const idleSettled = game.settleWorld(idle, NOW + 3 * game.HOUR, { activeAccountId: "a", experienceSince: NOW });
    expect(idleSettled.state.generals.idle.experience).toBe(100);

    let training = deploy(grant(joined(), "trainer"), "trainer");
    const position = training.generals.trainer.location;
    training.generals.trainer.experienceUpdatedAt = NOW;
    training.jobs["fake-training"] = {
      id: "fake-training", type: "training", accountId: "a", x: position.x, y: position.y,
      amount: 0, outputAmount: 0, cost: 0, startedAt: NOW, finishAt: NOW + 30 * game.MINUTE
    };
    const trainingSettled = game.settleWorld(training, NOW + 30 * game.MINUTE, { activeAccountId: "a", experienceSince: NOW });
    expect(trainingSettled.state.generals.trainer.experience).toBe(100);
    expect(trainingSettled.effects).toContainEqual(expect.objectContaining({ type: "general-experience-gained", source: "deployed", amount: 100 }));

    let late = deploy(grant(joined(), "late"), "late");
    late.generals.late.cultivationCount = 4;
    late.generals.late.experience = 0;
    late.generals.late.experienceUpdatedAt = NOW;
    const latePosition = late.generals.late.location;
    late.jobs["long-training"] = {
      id: "long-training", type: "training", accountId: "a", x: latePosition.x, y: latePosition.y,
      amount: 0, outputAmount: 0, cost: 0, startedAt: NOW, finishAt: NOW + 12 * game.HOUR
    };
    const lateSettled = game.settleWorld(late, NOW + 12 * game.HOUR, { activeAccountId: "a", experienceSince: NOW });
    expect(lateSettled.state.generals.late.experience).toBe(3_600);
    expect(game.generalExperienceRequirement(4)).toBe(3_600);
  });

  it("scales battle and march experience by the power gap and distance", () => {
    const general = { cultivationCount: 0, experience: 0 };
    expect(game.generalBattleExperienceGain(general, 1)).toBe(47.809);
    expect(game.generalBattleExperienceGain(general, 1_000)).toBe(10);
    expect(game.generalMarchExperienceGain(general, 120)).toBe(1);
    expect(game.generalMarchExperienceGain({ cultivationCount: 4 }, 12_000)).toBe(3_600);
  });

  it("adds the cultivation defense bonus to deployed general power only", () => {
    let state = deploy(grant(joined(), "guard"), "guard");
    const position = state.players.a.position!;
    state.generals.guard.talent = talents.normalizeTalent({ instanceId: "guard", talentId: "swift-column", progress: 1000 });
    const expectedRates = [0.05, 0.1, 0.2, 0.4, 0.6, 0.9];
    for (let count = 0; count <= 5; count += 1) {
      state.generals.guard.cultivationCount = count;
      const quote = game.regionDefenseQuote(state, position.x, position.y, NOW);
      expect(quote.cultivationBonusPower).toBe(Math.round(300 * expectedRates[count]!));
      expect(game.generalDefenseCultivationRate(count)).toBe(expectedRates[count]!);
      expect(quote.power).toBe(quote.basePower + quote.cultivationBonusPower + quote.talentBonusPower);
    }
  });

  it("keeps casualty losses bounded and decreases winner losses as the gap grows", () => {
    const winnerLosses: number[] = [];
    for (const winnerPower of [1_001, 1_100, 1_500, 2_000, 5_000, 10_000, 1_000_000]) {
      const result = game.battleCasualties(winnerPower, 1_000, 10_000, 1_000);
      expect(result.attackerWon).toBe(true);
      expect(result.defenderLosses).toBe(800);
      expect(result.attackerLosses).toBeLessThanOrEqual(Math.floor(winnerPower * 0.9));
      winnerLosses.push(result.attackerLosses);
    }
    expect(winnerLosses).toEqual([...winnerLosses].sort((a, b) => b - a));
    expect(winnerLosses.at(-1)).toBe(0);
    const reversed = game.battleCasualties(1_000, 1_500, 1_000, 10_000);
    expect(reversed.attackerWon).toBe(false);
    expect(reversed.attackerLosses).toBe(800);
    expect(reversed.defenderLosses).toBe(600);
    expect(game.battleCasualties(0, 0, 0, 100).defenderLosses).toBe(0);
  });

  it("uses per-soldier training pity, guarantees the 15,000th soldier, and emits at most one candidate", () => {
    const makeTraining = (seed: string, deployedCount: number, pityTrained = 0) => {
      let state = joined(seed);
      const player = state.players.a;
      const key = `${player.position.x},${player.position.y}`;
      state.cells[key].soldiers = 0;
      for (let index = 0; index < deployedCount; index += 1) {
        const id = `deployed-${index}`;
        const general = game.createFallbackGeneral({ id, name: id, gender: "female", power: 300, holderAccountId: "a", talentSeed: seed });
        general.status = "deployed";
        general.location = { ...player.position };
        general.talent = talents.normalizeTalent({ instanceId: id, talentId: "swift-column", progress: 0 });
        state.generals[id] = general;
        state.cells[key].generalIds.push(id);
      }
      state.jobs.training = {
        id: "training", type: "training", accountId: "a", x: player.position.x, y: player.position.y,
        amount: 1_000, outputAmount: 1_000, cost: 0, startedAt: NOW, finishAt: NOW
      };
      state.privatePlayers.a.trainingDiscoveryPity = { trained: pityTrained, discovered: false };
      return state;
    };
    expect(game.trainingGeneralDiscoveryChance(1)).toBe(game.TRAINING_GENERAL_DISCOVERY_INITIAL_CHANCE);
    expect(game.trainingGeneralDiscoveryChance(10_000)).toBeGreaterThan(game.trainingGeneralDiscoveryChance(1_000));
    expect(game.trainingGeneralDiscoveryChance(game.TRAINING_GENERAL_DISCOVERY_PITY_SOLDIERS)).toBe(1);
    const settled = game.settleWorld(makeTraining("pity-guarantee", 2, 14_999), NOW);
    const discoveries = settled.effects.filter((effect: any) => effect.type === "general-generation-request");
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]).toMatchObject({ sourceKind: "training", deployedGeneralCount: 2, deploymentMultiplier: 4, pitySoldier: 15_000 });
    expect(settled.state.privatePlayers.a.trainingDiscoveryPity.trained).toBe(0);

    const context = { action: "discovery", actorAccountId: "a", position: { x: 1, y: 1 }, relation: "allied", cell: { ownerAccountId: "a", population: 1_000 }, armySize: 1000, talents: [
      { generalId: "attack", holderAccountId: "a", status: "carried", talent: talents.normalizeTalent({ instanceId: "attack", talentId: "campaign-talent-scout", progress: 1000 }) },
      { generalId: "training", holderAccountId: "a", status: "deployed", location: { x: 1, y: 1 }, talent: talents.normalizeTalent({ instanceId: "training", talentId: "training-talent-register", progress: 1000 }) }
    ] };
    expect(talents.talentModifiers({}, { ...context, discoveryKind: "attack" }).discoveryChance).toBeGreaterThan(0);
    expect(talents.talentModifiers({}, { ...context, discoveryKind: "training" }).discoveryChance).toBeGreaterThan(0);
    expect(talents.talentModifiers({}, { ...context, discoveryKind: "other" }).discoveryChance).toBe(0);
  });

  it("creates, injects, dismisses, and clears battle reports", () => {
    let state = grant(joined(), "talker");
    const player = state.players.a;
    const target = { x: player.position.x === 63 ? 62 : player.position.x + 1, y: player.position.y };
    const targetKey = `${target.x},${target.y}`;
    state.cells[targetKey] = { ownerAccountId: "enemy", soldiers: 1, generalIds: [] };
    state.players.a.fieldArmySoldiers = 1_000;
    state.players.a.gold = 100_000;
    const started = game.applyIntent(state, {
      type: "march", to: target, soldiers: 1_000, attack: true, idempotencyKey: "report-march"
    }, { actorAccountId: "a", now: NOW });
    const settled = game.settleWorld(started.state, started.result.finishAt, { activeAccountId: "a", experienceSince: NOW });
    const report = settled.state.privatePlayers.a.battleReports[0];
    expect(report).toMatchObject({ outcome: "victory", target, soldiersGained: expect.any(Number), ownLosses: expect.any(Number) });
    expect(report.soldiersGained).toBeGreaterThan(0);
    const talk = game.applyIntent(settled.state, {
      type: "talk-general", generalId: "talker", topic: "请分析战果", battleReportId: report.id, idempotencyKey: "report-talk"
    }, { actorAccountId: "a", now: started.result.finishAt + 1 });
    expect(talk.result.topic).toBe("请分析战果");
    expect(talk.result.modelRequest.input.general.recentInteractions.at(-1)).toMatchObject({ kind: "battle-report" });
    const dismissed = game.applyIntent(talk.state, { type: "dismiss-battle-report", reportId: report.id, idempotencyKey: "report-dismiss" }, {
      actorAccountId: "a", now: started.result.finishAt + 2
    });
    expect(dismissed.state.privatePlayers.a.battleReports).toHaveLength(0);

    // A new, valid march marks all previous reports read before it spends gold.
    const nextTarget = { x: target.x, y: target.y === 63 ? 62 : target.y + 1 };
    dismissed.state.players.a.fieldArmySoldiers = 0;
    const synthetic = game.applyIntent(dismissed.state, {
      type: "march", to: nextTarget, soldiers: 0, attack: false, idempotencyKey: "report-clear-march"
    }, { actorAccountId: "a", now: started.result.finishAt + 3 });
    expect(synthetic.state.privatePlayers.a.battleReports).toHaveLength(0);
  });

  it("preserves deployed experience progress in the local service overlay", () => {
    let state = deploy(grant(joined(), "cached"), "cached");
    state.generals.cached.experience = 42;
    state.generals.cached.experienceUpdatedAt = NOW + game.HOUR;
    const service = new OnlineWorldService({ getAccount: () => ({ accountId: "a", username: "甲" }) });
    service.world = state;
    const overlay = service.captureLocalOverlay();
    expect(overlay.deployedGeneralProgress.cached).toMatchObject({ experience: 42 });
    service.world = structuredClone(state);
    delete service.world.generals.cached;
    service.localDeployedGeneralProgress = {};
    service.restoreLocalOverlay(overlay);
    const publicGeneral = game.publicGeneralState(state.generals.cached);
    publicGeneral.experience = 0;
    service.world.generals.cached = publicGeneral;
    service.applyLocalDeployedGeneralProgress();
    expect(service.world.generals.cached.experience).toBe(42);
    service.restoreLocalOverlay(null);
    expect(service.localDeployedGeneralProgress).toEqual({});
  });
});
