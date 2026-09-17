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
  it("uses the hourly mining economy without resource-rank inversions", () => {
    const population = 4000;
    let previousHourly = 0;
    for (let resourceRank = 0; resourceRank < game.RESOURCE_GRADES.length; resourceRank += 1) {
      const cell = { population, resourceRank };
      const cycleMs = game.resourceCycleMs(cell);
      const yieldPerCycle = game.resourceYield(cell);
      const expected = Math.max(1, Math.round((400 + population * 0.09) * (1 + resourceRank * 0.08) * cycleMs / game.HOUR));
      const hourly = yieldPerCycle * game.HOUR / cycleMs;
      expect(yieldPerCycle).toBe(expected);
      expect(hourly).toBeGreaterThan(previousHourly);
      previousHourly = hourly;
    }
  });

  it("settles elapsed legacy mining cycles at the stored rate before migrating future cycles", () => {
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
    const migrated = first.state.jobs[job.id];
    expect(migrated.yieldFormulaVersion).toBe(game.RESOURCE_YIELD_FORMULA_VERSION);
    expect(migrated.yieldPerCycle).toBe(game.resourceYield(game.staticCell(state.seed, position.x, position.y)));
    const second = game.settleWorld(first.state, now + job.cycleMs * 4);
    expect(second.state.players.a.gold).toBe(before + oldYield * 3 + migrated.yieldPerCycle);
  });

  it("migrates every general to exactly one deterministic talent", () => {
    const legacy: any = { id: "legacy", gender: "female", setting: "旧将。", power: 500 };
    game.ensureGeneralProfile(legacy);
    expect(legacy.talent).toEqual(game.ensureGeneralProfile(structuredClone(legacy)).talent);
    expect(talentEngine.TALENT_BY_ID[legacy.talent.talentId]).toBeTruthy();
    expect(legacy.cultivationCount).toBe(0);
    expect(game.generalTalentState(legacy).description).toMatch(/%/);
  });

  it("uses the six-hour first gate, one material, linear gold power, and an instant result", () => {
    const joinedAt = 1_000_000;
    let state = grant(joined(joinedAt), joinedAt, "cultivator");
    state.players.a.gold = 20_000;
    expect(state.privatePlayers.a.materials.white).toBe(0);
    state.privatePlayers.a.materials.white = 1;
    expect(() => game.applyIntent(state, {
      type: "cultivate-general", generalId: "cultivator", goldInvestment: 5000, materialId: "white", idempotencyKey: "too-early"
    }, { actorAccountId: "a", now: joinedAt + 6 * game.HOUR - 1 })).toThrow(/6小时/);

    const before = state.generals.cultivator.power;
    const cultivated = game.applyIntent(state, {
      type: "cultivate-general", generalId: "cultivator", goldInvestment: 8000, materialId: "white", idempotencyKey: "cultivate-1"
    }, { actorAccountId: "a", now: joinedAt + 6 * game.HOUR });
    expect(cultivated.result.durationMs).toBe(0);
    expect(cultivated.result.basePowerGainPercent).toBe(10);
    expect(cultivated.result.randomFactor).toBeGreaterThanOrEqual(0.9);
    expect(cultivated.result.randomFactor).toBeLessThan(1.1);
    expect(cultivated.result.powerGainPercent).toBeGreaterThanOrEqual(9);
    expect(cultivated.result.powerGainPercent).toBeLessThanOrEqual(11.2);
    expect(cultivated.state.jobs).toEqual({});
    expect(cultivated.state.privatePlayers.a.materials.white).toBe(0);
    expect(cultivated.state.generals.cultivator.cultivationCount).toBe(1);
    expect(cultivated.state.generals.cultivator.power).toBeGreaterThan(before);
    expect(cultivated.state.generals.cultivator.talent.progress).toBeGreaterThan(state.generals.cultivator.talent.progress);
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
    expect(game.marchDurationMs(126)).toBe(126 * 30_000);
    const now = 1_000_000;
    let state = grant(joined(now), now, "runner");
    const target = adjacent(state.players.a.position);
    state.generals.runner.talent = talentEngine.normalizeTalent({ instanceId: "runner", talentId: "swift-column", progress: 1000 });
    const quote = game.marchQuote(state, "a", target, 1, ["runner"], false, now + 1);
    expect(quote.baseDurationMs).toBe(30_000);
    expect(quote.durationMs).toBe(Math.round(30_000 * 0.84));
    const march = game.applyIntent(state, {
      type: "march", to: target, soldiers: 1, generalIds: ["runner"], attack: false, idempotencyKey: "talented-march"
    }, { actorAccountId: "a", now: now + 1 });
    expect(march.result.durationMs).toBe(quote.durationMs);
    expect(march.state.jobs[march.result.jobId].finishAt).toBe(now + 1 + quote.durationMs);
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

  it("spawns public treasures and claims one material into only the local inventory", () => {
    const now = 1_000_000;
    let state = joined(now);
    const target = adjacent(state.players.a.position);
    state.treasureSpawns = { cache: { id: "cache", epoch: 1, x: target.x, y: target.y, materialId: "blue", spawnedAt: now } };
    state.treasureEpoch = 1;
    const before = state.privatePlayers.a.materials.blue;
    const march = game.applyIntent(state, { type: "march", to: target, soldiers: 0, generalIds: [], attack: false, idempotencyKey: "treasure-march" }, { actorAccountId: "a", now });
    state = game.settleWorld(march.state, march.result.finishAt).state;
    expect(state.privatePlayers.a.materials.blue).toBe(before + 1);
    expect(state.treasureSpawns.cache).toBeUndefined();
    expect(state.claimedTreasures.cache).toMatchObject({ accountId: "a", x: target.x, y: target.y });
    const projection = game.projectWorldState(state, "a", march.result.finishAt);
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
