import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");

function joined(now = 1_000_000) {
  const base = game.createWorld({ seed: "test-seed", seasonId: "season", startedAt: now, authorityAccountId: "a" });
  return game.applyIntent(base, {
    type: "join", orientation: "women", displayName: "甲", characterProfileId: "profile-a",
    characterTags: ["傲娇", "勇敢", "冷静", "长发", "黑发", "红瞳", "高挑", "军装"],
    initialGeneralWish: "一名善守城、重信义的良将", idempotencyKey: "join-a"
  }, { actorAccountId: "a", now }).state;
}

describe("grid conquest rules", () => {
  it("derives immutable 64x64 cell facts from seed and coordinates", () => {
    const first = game.staticCell("seed", 12, 31);
    const second = game.staticCell("seed", 12, 31);
    expect(first).toEqual(second);
    expect(first.population).toBeGreaterThanOrEqual(100);
    expect(first.population).toBeLessThanOrEqual(10000);
    expect(first.garrisonCap).toBe(Math.floor(first.population * 0.2));
    expect(game.RESOURCE_GRADES).toContain(first.resourceGrade);
  });

  it("settles automatic mining from host time", () => {
    const now = 1_000_000;
    let state = joined(now);
    const player = state.players.a;
    const started = game.applyIntent(state, { type: "start-mining", x: player.position.x, y: player.position.y, auto: true, idempotencyKey: "mine" }, { actorAccountId: "a", now });
    state = started.state;
    const job = state.jobs[started.result.jobId];
    const before = state.players.a.gold;
    const settled = game.settleWorld(state, now + job.cycleMs * 3 + 1);
    expect(settled.state.players.a.gold).toBe(before + job.yieldPerCycle * 3);
    expect(settled.state.jobs[job.id]).toBeTruthy();
  });

  it("stops mining and cancels unfinished training when the territory is lost", () => {
    const now = 1_000_000;
    const initial = joined(now);
    const player = initial.players.a;
    const key = `${player.position.x},${player.position.y}`;
    const mined = game.applyIntent(initial, { type: "start-mining", x: player.position.x, y: player.position.y, auto: true, idempotencyKey: "mine-before-loss" }, { actorAccountId: "a", now });
    const miningJob = mined.state.jobs[mined.result.jobId];
    const goldBefore = mined.state.players.a.gold;
    mined.state.cells[key].ownerAccountId = "enemy";
    const miningSettlement = game.settleWorld(mined.state, now + miningJob.cycleMs * 2);
    expect(miningSettlement.state.players.a.gold).toBe(goldBefore);
    expect(miningSettlement.state.jobs[miningJob.id]).toBeUndefined();
    expect(miningSettlement.effects).toContainEqual(expect.objectContaining({ type: "mining-stopped", reason: "territory-lost" }));

    const trained = game.applyIntent(initial, { type: "train", x: player.position.x, y: player.position.y, amount: 10, idempotencyKey: "train-before-loss" }, { actorAccountId: "a", now });
    const trainingJob = trained.state.jobs[trained.result.jobId];
    const soldiersBefore = trained.state.cells[key].soldiers;
    trained.state.cells[key].ownerAccountId = "enemy";
    const trainingSettlement = game.settleWorld(trained.state, trainingJob.finishAt);
    expect(trainingSettlement.state.cells[key].soldiers).toBe(soldiersBefore);
    expect(trainingSettlement.state.jobs[trainingJob.id]).toBeUndefined();
    expect(trainingSettlement.effects).toContainEqual(expect.objectContaining({ type: "training-cancelled", reason: "territory-lost" }));
  });

  it("rejects training above the fixed twenty-percent garrison cap", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const cell = state.cells[`${player.position.x},${player.position.y}`];
    const info = game.staticCell(state.seed, player.position.x, player.position.y);
    expect(() => game.applyIntent(state, { type: "train", x: player.position.x, y: player.position.y, amount: info.garrisonCap - cell.soldiers + 1, idempotencyKey: "too-many" }, { actorAccountId: "a", now })).toThrow(/驻军上限/);
  });

  it("allows only one concurrent training job in the same cell", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const first = game.applyIntent(state, { type: "train", x: player.position.x, y: player.position.y, amount: 1, idempotencyKey: "train-one" }, { actorAccountId: "a", now });
    expect(() => game.applyIntent(first.state, { type: "train", x: player.position.x, y: player.position.y, amount: 1, idempotencyKey: "train-two" }, { actorAccountId: "a", now: now + 1 })).toThrow(/只能同时进行一项练兵/);
  });

  it("charges and times a march while ignoring caller-provided timestamps", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const target = { x: (player.position.x + 2) % 64, y: player.position.y };
    const before = player.gold;
    const march = game.applyIntent(state, { type: "march", to: target, soldiers: 1, attack: false, finishAt: 0, idempotencyKey: "march" }, { actorAccountId: "a", now });
    const job = march.state.jobs[march.result.jobId];
    expect(job.finishAt).toBe(now + game.marchDurationMs(2));
    expect(march.state.players.a.gold).toBe(before - game.marchCost(2, 1));
  });

  it("allows dialogue only with a carried general and keeps compact memory", () => {
    const now = 1_000_000;
    let state = joined(now);
    const granted = game.applyIntent(state, { type: "grant-general", generalId: "g", name: "青禾", gender: "female", setting: "善守城，重信义。", power: 500, discoveryId: "grant", idempotencyKey: "grant" }, { actorAccountId: "a", authorityAccountId: "a", now });
    state = granted.state;
    const talk = game.applyIntent(state, { type: "talk-general", generalId: "g", topic: "讨论北境战事", idempotencyKey: "talk" }, { actorAccountId: "a", now: now + 1 });
    expect(talk.result.modelRequest.keyword).toContain("青禾");
    expect(() => game.applyIntent(talk.state, { type: "talk-general", generalId: "g", topic: "连续请求", idempotencyKey: "talk-too-fast" }, { actorAccountId: "a", now: now + 2 })).toThrow(/过于频繁/);
    expect(() => game.applyIntent(talk.state, { type: "talk-general", generalId: "g", topic: "冷却后请求", idempotencyKey: "talk-after-cooldown" }, { actorAccountId: "a", now: now + 1 + game.DIALOGUE_COOLDOWN_MS })).not.toThrow();
    const remembered = game.applyIntent(talk.state, { type: "record-general-dialogue", generalId: "g", topic: "北境战事", intimacyDelta: 2, idempotencyKey: "memory" }, { actorAccountId: "a", now: now + 2 });
    expect(remembered.state.generals.g.memoryText).toContain("谈论北境战事");
    expect(remembered.state.generals.g.memoryText).toContain("言谈：");
    expect(remembered.state.generals.g.memoryText).toContain("经历：");
    expect(remembered.state.generals.g.memoryText.length).toBeLessThanOrEqual(1000);
  });

  it("resolves combat instantly when a timed march reaches a neutral region", () => {
    const now = 1_000_000;
    let state = joined(now);
    const player = state.players.a;
    const target = { x: player.position.x === 63 ? 62 : player.position.x + 1, y: player.position.y };
    const defenders = game.staticCell(state.seed, target.x, target.y).neutralPower;
    player.fieldArmySoldiers = defenders + 10;
    player.gold = 1_000_000;
    const march = game.applyIntent(state, { type: "march", to: target, soldiers: defenders + 10, attack: true, idempotencyKey: "neutral-attack" }, { actorAccountId: "a", now });
    const settled = game.settleWorld(march.state, march.result.finishAt);
    expect(settled.state.cells[`${target.x},${target.y}`].ownerAccountId).toBe("a");
    expect(settled.effects.some((effect: any) => effect.type === "battle-won" && effect.accountId === "a")).toBe(true);
  });

  it("captures every deployed defending general after a successful player attack", () => {
    const now = 1_000_000;
    const state = joined(now);
    const attacker = state.players.a;
    const target = { x: attacker.position.x === 63 ? 62 : attacker.position.x + 1, y: attacker.position.y };
    state.players.b = { accountId: "b", displayName: "乙", gold: 1000, position: target, fieldArmySoldiers: 0, carriedGeneralIds: [], joinedAt: now };
    state.privatePlayers.b = { orientation: "any" };
    const defendingGeneral = game.createFallbackGeneral({ id: "defender", name: "守城将", gender: "female", setting: "守土有方。", power: 100, holderAccountId: "b", year: 1 });
    defendingGeneral.status = "deployed";
    defendingGeneral.location = target;
    state.generals.defender = defendingGeneral;
    const targetCell = game.dynamicCell(state, target.x, target.y);
    targetCell.ownerAccountId = "b";
    targetCell.soldiers = 1;
    targetCell.generalIds = ["defender"];
    attacker.fieldArmySoldiers = 1000;
    attacker.gold = 1_000_000;
    const march = game.applyIntent(state, { type: "march", to: target, soldiers: 1000, generalIds: [], attack: true, idempotencyKey: "capture-general" }, { actorAccountId: "a", now });
    const settled = game.settleWorld(march.state, march.result.finishAt);
    expect(settled.state.cells[`${target.x},${target.y}`].ownerAccountId).toBe("a");
    expect(settled.state.generals.defender.holderAccountId).toBe("a");
    expect(settled.state.generals.defender.capturedFromAccountId).toBe("b");
    expect(settled.state.players.a.carriedGeneralIds).not.toContain("defender");
    expect(settled.state.generals.defender.status).toBe("captured");
    expect(settled.state.generals.defender.captivityHistory).toContainEqual(expect.objectContaining({ captorAccountId: "a", formerMasterAccountId: "b" }));
    expect(settled.effects).toContainEqual(expect.objectContaining({ type: "battle-won", capturedGeneralIds: ["defender"] }));
  });

  it("keeps gold, queued work and carried generals out of another player's projection", () => {
    const now = 1_000_000;
    let state = joined(now);
    const player = state.players.a;
    state = game.applyIntent(state, { type: "start-mining", x: player.position.x, y: player.position.y, auto: true, idempotencyKey: "private-mine" }, { actorAccountId: "a", now }).state;
    state = game.applyIntent(state, { type: "grant-general", generalId: "private-general", name: "青禾", gender: "female", setting: "善守城。", power: 500, discoveryId: "private", idempotencyKey: "private-general" }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    const publicState = game.projectWorldState(state, null);
    expect(publicState.players.a.gold).toBeUndefined();
    expect(publicState.players.a.carriedGeneralIds).toBeUndefined();
    expect(publicState.players.a.position).toBeUndefined();
    expect(publicState.players.a.joinedAt).toBeUndefined();
    expect(publicState.generals["private-general"]).toBeUndefined();
    expect(Object.keys(publicState.jobs)).toHaveLength(0);
    expect(publicState.processedIntents).toBeUndefined();
    const ownState = game.projectWorldState(state, "a");
    expect(ownState.players.a.gold).toBeTypeOf("number");
    expect(ownState.generals["private-general"].name).toBe("青禾");
    expect(Object.keys(ownState.jobs)).toHaveLength(1);
  });

  it("blocks banned accounts and removes reset players into a new epoch", () => {
    const state = joined(1_000_000);
    state.players.b = { accountId: "b", accountName: "b@example", displayName: "乙", gold: 500, position: { x: 2, y: 2 }, fieldArmySoldiers: 3, carriedGeneralIds: [], joinedAt: 1_000_000 };
    state.cells["2,2"] = { ownerAccountId: "b", soldiers: 5, generalIds: [] };
    state.bans.b = { accountId: "b", accountName: "b@example", displayName: "乙", banned: true };
    expect(() => game.applyIntent(state, { type: "join", orientation: "any", characterProfileId: "p", characterTags: Array(8).fill("标签"), initialGeneralWish: "良将", idempotencyKey: "banned" }, { actorAccountId: "b", now: 1_000_001 })).toThrow(/封禁/);
    game.resetPlayerState(state, "b", 1);
    expect(state.players.b).toBeUndefined();
    expect(state.cells["2,2"]).toBeUndefined();
    expect(state.playerEpochs.b).toBe(1);
    expect(state.bans.b.banned).toBe(true);
  });

  it("publishes a deployed general archive with the shared map state", () => {
    const state = joined(1_000_000);
    state.generals.deployed = game.createFallbackGeneral({ id: "deployed", name: "守城将", gender: "female", setting: "公开的守城设定。", power: 700, holderAccountId: "a", year: 1 });
    state.generals.deployed.status = "deployed";
    state.generals.deployed.location = { ...state.players.a.position };
    state.generals.deployed.memoryText = "仅本人可见的交谈记忆。";
    state.generals.deployed.memory = { intimacy: { a: 9 } };
    const publicState = game.projectWorldState(state, null);
    expect(publicState.generals.deployed).toMatchObject({ name: "守城将", setting: "公开的守城设定。", power: 700, status: "deployed" });
    expect(publicState.generals.deployed.memoryText).toBe("仅本人可见的交谈记忆。");
    expect(publicState.generals.deployed.memory).toEqual({ intimacy: { a: 9 } });
    const ownState = game.projectWorldState(state, "a");
    expect(ownState.generals.deployed.memoryText).toBe("仅本人可见的交谈记忆。");
  });
});
