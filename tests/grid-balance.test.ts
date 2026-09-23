import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");
const talents = require("../electron/grid-talents.cjs");
const { BALANCE_FIELDS, BALANCE_DEFAULTS, normalizeBalance } = require("../electron/grid-balance.cjs");
const { generalMemoryQualityIssue } = require("../electron/online-world-service.cjs");
const now = Date.parse("2026-09-23T12:30:00Z");

function joined(balance: any = {}) {
  const base = game.createWorld({ seed: "balance-test", seasonId: "test", authorityAccountId: "a", startedAt: now });
  base.balance = normalizeBalance(balance, true);
  return game.applyIntent(base, { type: "join", displayName: "甲", orientation: "any", idempotencyKey: "join",
    characterProfileId: "test", characterTags: ["果断"], initialGeneralWish: "坚毅的将领" },
    { actorAccountId: "a", now }).state;
}

describe("global balance configuration", () => {
  it("keeps defaults explicit and rejects malformed, unknown and contradictory values", () => {
    expect(normalizeBalance()).toEqual(BALANCE_DEFAULTS);
    expect(new Set(BALANCE_FIELDS.map((field: any) => field.key)).size).toBe(BALANCE_FIELDS.length);
    for (const bad of [{ marchSeconds: -1 }, { marchSeconds: "10" }, { dailyRedTime: "24:00" },
      { generalPowerMin: 1000, generalPowerMax: 10 }, { unknown: 1 }, { dailyRedMin: 3, dailyRedMax: 2 }]) {
      expect(() => normalizeBalance(bad, true)).toThrow();
    }
    const weights = Object.fromEntries(["white", "green", "blue", "purple", "gold", "red"].map(id => [`talentWeight_${id}`, 0]));
    expect(() => normalizeBalance(weights, true)).toThrow();
    expect(normalizeBalance({ marchSeconds: NaN }).marchSeconds).toBe(15);
  });

  it("uses author settings for initial player, new generals and initial rarity", () => {
    const weights = Object.fromEntries(["white", "green", "blue", "purple", "gold", "red"].map(id => [`talentWeight_${id}`, id === "red" ? 1 : 0]));
    const state = joined({ playerPowerMin: 99, playerPowerMax: 99, generalPowerMin: 177, generalPowerMax: 177,
      startingGold: 333, initialGarrisonRatio: .25, ...weights });
    expect(state.players.a.power).toBe(99);
    expect(state.players.a.gold).toBe(333);
    const granted = game.applyIntent(state, { type: "grant-general", generalId: "g", generated: true, name: "测试", idempotencyKey: "grant" },
      { actorAccountId: "a", authorityAccountId: "a", now });
    expect(granted.state.generals.g).toMatchObject({ power: 177, experience: 0, talent: { rarity: "red" } });
    expect(game.generatedGeneralPower("seed", "a", "preview", state)).toBe(177);
  });

  it("changes training fees and duration while existing jobs keep their original quote", () => {
    const state = joined({ trainingBaseSeconds: 3, trainingSoldierSeconds: 2, trainingSoldierGold: 8 });
    const p = state.players.a.position;
    state.cells[`${p.x},${p.y}`].soldiers = 0;
    state.players.a.gold = 10000;
    const training = game.applyIntent(state, { type: "train", x: p.x, y: p.y, amount: 10, idempotencyKey: "train" },
      { actorAccountId: "a", now });
    expect(training.result).toMatchObject({ cost: 80, durationMs: 23000 });
    expect(training.state.players.a.gold).toBe(9920);
    training.state.balance = normalizeBalance({ trainingBaseSeconds: 999, trainingSoldierGold: 999 });
    const finished = game.settleWorld(training.state, now + 23000);
    expect(finished.state.cells[`${p.x},${p.y}`].soldiers).toBe(10);
  });

  it("uses mining, movement, experience and combat settings in engine calculations", () => {
    const state = joined({ miningSeconds: 70, miningCooldownMinMinutes: 2, miningCooldownMaxMinutes: 9,
      miningYieldRatio: 3, marchSeconds: 20, ownMarchRatio: .5, marchBaseGold: 5,
      marchGeneralGold: 3, marchSoldiersPerGold: 20, battleExperienceMax: .6, battleExperienceMin: .2,
      marchExperienceDivisor: 1000, defenseBonus_0: .2, loserCasualtyRatio: .4, winnerCasualtyRatio: .3 });
    const cell = game.staticCell(state.seed, 1, 1);
    expect(game.resourceCycleMs(cell, state)).toBe(70000);
    expect(game.miningCooldownMs({ resourceRank: 0 }, state)).toBe(120000);
    expect(game.miningCooldownMs({ resourceRank: 14 }, state)).toBe(540000);
    expect(game.resourceYield(cell, state)).toBeGreaterThan(game.resourceYield(cell) * 2.9);
    const route = { weightQuarters: 6 };
    expect(game.marchRouteDurationMs(route, state)).toBe(30000);
    expect(game.marchRouteCost(route, 20, 1, state)).toBe(14);
    const general = game.createFallbackGeneral({ holderAccountId: "a", power: 150 });
    expect(game.generalBattleExperienceGain(general, 0, state)).toBe(60);
    expect(game.generalMarchExperienceGain(general, 1, state)).toBe(.1);
    expect(game.generalDefenseBonusPower(general, state)).toBe(30);
    expect(game.battleCasualties(200, 100, 1000, 1000, state)).toMatchObject({ attackerLosses: 15, defenderLosses: 40 });
  });

  it("uses exact cultivation investment and configurable gain ranges", () => {
    const state = joined({ cultivationGoldMin_0: 10, cultivationGoldMax_0: 100,
      cultivationGainMin_0: .2, cultivationGainMax_0: .4, cultivationRandomMin: 1, cultivationRandomMax: 1,
      playerCultivationGoldRatio: 3, playerCultivationPowerRatio: .5 });
    const general = game.createFallbackGeneral({ id: "g", holderAccountId: "a", power: 100 });
    general.experience = 100;
    general.talent = talents.normalizeTalent({ talentId: "swift-column", instanceId: "g", progress: 0 });
    state.generals.g = general;
    state.players.a.carriedGeneralIds = ["g"];
    const quote = game.cultivationQuote(general, state.players.a, now, { state, goldInvestment: 55 });
    expect(quote).toMatchObject({ goldMin: 10, goldMax: 100, cost: 55, powerGain: 30 });
    const player = game.cultivationQuote(state.players.a, state.players.a, now, { state, targetType: "player" });
    expect(player).toMatchObject({ goldMin: 30, goldMax: 300 });
  });

  it("respects configurable discovery pity and treasure weights", () => {
    const state = joined({ trainingDiscoveryInitial: .01, trainingDiscoveryPity: 100, trainingDiscoveryCurve: 2,
      battleDiscoveryMin: .1, battleDiscoveryMax: .5, initialTreasureCount: 5,
      treasureWeight_white: 0, treasureWeight_green: 0, treasureWeight_blue: 0, treasureWeight_purple: 0, treasureWeight_gold: 1 });
    expect(game.trainingGeneralDiscoveryChance(100, state)).toBe(1);
    expect(game.trainingGeneralDiscoveryChance(1, state)).toBeGreaterThanOrEqual(.01);
    expect(game.generalDiscoveryChance(100, state)).toBe(.1);
    expect(game.generalDiscoveryChance(10000, state)).toBe(.5);
    game.scatterTreasures(state, {}, now);
    expect(Object.values(state.treasureSpawns)).toHaveLength(5);
    expect(Object.values(state.treasureSpawns).every((spawn: any) => spawn.materialId === "gold")).toBe(true);
  });

  it("schedules one additive red batch per Beijing date without covering occupied cells", () => {
    const state = joined();
    state.treasureSpawns.old = { id: "old", x: 10, y: 10, materialId: "gold" };
    expect(game.dailyRedTreasureBatch(state, now - 1)).toBeNull();
    const batch = game.dailyRedTreasureBatch(state, now);
    expect(batch.day).toBe("2026-09-23");
    expect(Object.values(batch.treasureSpawns).length).toBeGreaterThanOrEqual(1);
    expect(Object.values(batch.treasureSpawns).length).toBeLessThanOrEqual(2);
    for (const spawn of Object.values(batch.treasureSpawns) as any[]) {
      expect(["red-ascend", "red-reroll"]).toContain(spawn.materialId);
      expect(state.cells[`${spawn.x},${spawn.y}`]?.ownerAccountId).toBeFalsy();
      expect(`${spawn.x},${spawn.y}`).not.toBe("10,10");
    }
    expect(state.treasureSpawns.old).toBeDefined();
    state.dailyRedDates = [batch.day];
    expect(game.dailyRedTreasureBatch(state, now + 3600000)).toBeNull();
    state.balance.dailyRedTime = "21:00";
    state.dailyRedDates = [];
    expect(game.dailyRedTreasureBatch(state, now)).toBeNull();
  });

  it.each([0, 250, 600, 950, 1000])("rerolls talent %s without losing its existing growth", progress => {
    const talent = talents.normalizeTalent({ instanceId: "g", talentId: "swift-column", progress });
    const options = { seed: "s", nonce: "use" };
    const gold = talents.upgradeTalent(talent, "gold", options);
    const red = talents.upgradeTalent(talent, "red-reroll", options);
    expect(red.talent.talentId).not.toBe(talent.talentId);
    expect(red.talent.progress).toBe(gold.talent.progress);
    expect(red.talent.potency).toBeGreaterThanOrEqual(talent.potency);
  });

  it("publishes only a bounded summary and preserves the owner's private conversation", () => {
    const state = joined();
    const general = game.createFallbackGeneral({ id: "g", holderAccountId: "a" });
    Object.assign(general, { status: "deployed", location: state.players.a.position, memoryText: "言谈：同行。经历：守城。",
      interactionHistory: [{ userText: "私下原话", reply: "完整回答", narration: "动作旁白" }] });
    general.memory.entries.push({ text: "私下事件" });
    state.generals.g = general;
    const publicState = game.projectWorldState(state, null, now);
    expect(publicState.generals.g.interactionHistory).toEqual([]);
    expect(publicState.generals.g.memory.entries).toEqual([]);
    expect(JSON.stringify(publicState)).not.toContain("私下原话");
    expect(game.projectWorldState(state, "a", now).generals.g.interactionHistory).toHaveLength(1);
    general.memoryText = "长".repeat(151);
    expect(game.publicGeneralState(general).memoryText).toBe("");
    const memory = { category: "speech", summary: "交谈", emotion: "平静", intimacyDelta: 0, compactMemory: "言谈：经历：" + "字".repeat(144) };
    expect(generalMemoryQualityIssue(memory)).toBeNull();
    expect(generalMemoryQualityIssue({ ...memory, compactMemory: memory.compactMemory + "字" })).toContain("150");
  });
});
