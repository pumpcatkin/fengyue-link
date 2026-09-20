import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");
const talentEngine = require("../electron/grid-talents.cjs");

function joined(now = 1_000_000) {
  const base = game.createWorld({ seed: "test-seed", seasonId: "season", startedAt: now, authorityAccountId: "a" });
  return game.applyIntent(base, {
    type: "join", orientation: "women", displayName: "甲", characterProfileId: "profile-a",
    characterTags: ["傲娇", "勇敢", "冷静", "长发", "黑发", "红瞳", "高挑", "军装"],
    initialGeneralWish: "一名善守城、重信义的良将", idempotencyKey: "join-a"
  }, { actorAccountId: "a", now }).state;
}

describe("grid conquest rules", () => {
  it("uses unified pill names for every treasure material color", () => {
    expect(talentEngine.MATERIALS.map((item: any) => item.label)).toEqual([
      "养气丹", "聚灵丹", "凝元丹", "紫府丹", "金髓丹", "赤曜丹", "赤曜丹"
    ]);
  });
  it("grants new players 500 starting gold and 500 base power without changing older progress", () => {
    const now = 1_000_000;
    const state = joined(now);
    expect(state.players.a.gold).toBe(500);
    expect(state.players.a.basePower).toBe(500);
    expect(state.players.a.power).toBe(500);
    state.players.a.gold = 321;
    state.players.a.basePower = 300;
    state.players.a.power = 300;
    const restored = game.settleWorld(state, now + 1).state.players.a;
    expect(restored.gold).toBe(321);
    expect(restored.basePower).toBe(300);
    expect(restored.power).toBe(300);
  });
  it("requires profile completion and makes the initial wish binding for generation", () => {
    const profile = game.buildPlayerProfileContextRequest({
      displayName: "茂密", basicInfo: "猫亚人", appearance: "白色头发"
    }, "profile-request");
    expect(profile.input.instruction).toContain("主动补全");
    expect(profile.input.instruction).toContain("禁止使用未提供");

    const state = game.createWorld({ seed: "prompt-seed", seasonId: "season", startedAt: 1_000_000, authorityAccountId: "a" });
    state.privatePlayers.a = { orientation: "women", characterTags: ["无关标签"] };
    const request = game.buildGeneralGenerationRequest(state, {
      accountId: "a", gender: "female", population: 1000, resourceGrade: "B", x: 1, y: 2,
      initial: true, initialWish: "白发猫亚人，善于守城"
    }, "general-request");
    expect(request.input.initialWish).toBe("白发猫亚人，善于守城");
    expect(request.input.directionTags).toEqual([]);
    expect(request.input.instruction).toContain("最高优先级绑定要求");
    expect(request.input.instruction).toContain("appearanceSetting");
    expect(request.input.instruction).toContain("coreSetting");
  });

  it("derives immutable 64x64 cell facts from seed and coordinates", () => {
    const first = game.staticCell("seed", 12, 31);
    const second = game.staticCell("seed", 12, 31);
    expect(first).toEqual(second);
    expect(first.population).toBeGreaterThanOrEqual(100);
    expect(first.population).toBeLessThanOrEqual(10000);
    expect(first.garrisonCap).toBe(Math.floor(first.population * 0.2));
    expect(game.RESOURCE_GRADES).toContain(first.resourceGrade);
  });

  it("settles one fixed ten-minute mining run and starts its resource-rank cooldown", () => {
    const now = 1_000_000;
    let state = joined(now);
    const player = state.players.a;
    const started = game.applyIntent(state, { type: "start-mining", x: player.position.x, y: player.position.y, auto: true, idempotencyKey: "mine" }, { actorAccountId: "a", now });
    state = started.state;
    const job = state.jobs[started.result.jobId];
    const before = state.players.a.gold;
    expect(job.cycleMs).toBe(10 * game.MINUTE);
    const settled = game.settleWorld(state, job.finishAt);
    expect(settled.state.players.a.gold).toBe(before + job.yieldPerCycle);
    expect(settled.state.jobs[job.id]).toBeUndefined();
    const effect = settled.effects.find((item: any) => item.type === "mining-complete");
    expect(effect.cooldownMs).toBe(game.miningCooldownMs(game.staticCell(state.seed, player.position.x, player.position.y)));
    expect(() => game.applyIntent(settled.state, {
      type: "start-mining", x: player.position.x, y: player.position.y, idempotencyKey: "mine-during-cooldown"
    }, { actorAccountId: "a", now: job.finishAt })).toThrow(/冷却/);
  });

  it("scales completed mining cooldowns from one to four hours by resource rank", () => {
    expect(game.miningCooldownMs({ resourceRank: 0 })).toBe(game.HOUR);
    expect(game.miningCooldownMs({ resourceRank: game.RESOURCE_GRADES.length - 1 })).toBe(4 * game.HOUR);
    const values = game.RESOURCE_GRADES.map((_: string, resourceRank: number) => game.miningCooldownMs({ resourceRank }));
    expect(values).toEqual([...values].sort((left, right) => left - right));
  });

  it("limits a player to three concurrent mining territories", () => {
    const now = 1_000_000;
    let state = joined(now);
    const origin = state.players.a.position;
    const positions = [origin, { x: origin.x + 1, y: origin.y }, { x: origin.x, y: origin.y + 1 }, { x: origin.x + 1, y: origin.y + 1 }];
    for (const point of positions) state.cells[`${point.x},${point.y}`] = { ownerAccountId: "a", soldiers: 0, generalIds: [] };
    for (let index = 0; index < 3; index += 1) {
      state = game.applyIntent(state, { type: "start-mining", ...positions[index], idempotencyKey: `mine-${index}` }, { actorAccountId: "a", now }).state;
    }
    expect(() => game.applyIntent(state, { type: "start-mining", ...positions[3], idempotencyKey: "mine-fourth" }, { actorAccountId: "a", now })).toThrow(/最多同时开采 3 块/);
  });

  it("assigns model-generated generals a stable authoritative power from 250 to 350", () => {
    const now = 1_000_000;
    const state = joined(now);
    const intent = {
      type: "grant-general", generalId: "generated", name: "新将", gender: "female", setting: "善战。",
      power: 99999, generated: true, powerSeed: "discovery-1", discoveryId: "discovery-1", idempotencyKey: "grant-generated"
    };
    const granted = game.applyIntent(state, intent, { actorAccountId: "a", authorityAccountId: "a", now });
    const expected = game.generatedGeneralPower(state.seed, "a", "discovery-1");
    expect(granted.state.generals.generated.power).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(250);
    expect(expected).toBeLessThanOrEqual(350);
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

  it("keeps the training max action inside the garrison cap after yield talents", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const key = `${player.position.x},${player.position.y}`;
    const info = game.staticCell(state.seed, player.position.x, player.position.y);
    state.cells[key].soldiers = info.garrisonCap - 100;
    state.generals.office = {
      id: "office", holderAccountId: "a", status: "carried", name: "军务官", power: 500,
      basePower: 500, trainingLevel: 0,
      talent: talentEngine.normalizeTalent({ instanceId: "office", talentId: "recruiting-office", progress: 99 })
    };
    player.carriedGeneralIds = ["office"];
    const result = game.applyIntent(state, {
      type: "train", mode: "max", amount: 100, x: player.position.x, y: player.position.y, idempotencyKey: "training-max-talent"
    }, { actorAccountId: "a", now });
    expect(result.result.amount).toBeLessThanOrEqual(100);
    expect(result.result.outputAmount).toBeLessThanOrEqual(100);
  });

  it("allows only one concurrent training job in the same cell", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const first = game.applyIntent(state, { type: "train", x: player.position.x, y: player.position.y, amount: 1, idempotencyKey: "train-one" }, { actorAccountId: "a", now });
    expect(() => game.applyIntent(first.state, { type: "train", x: player.position.x, y: player.position.y, amount: 1, idempotencyKey: "train-two" }, { actorAccountId: "a", now: now + 1 })).toThrow(/只能同时进行一项练兵/);
  });

  it("raises training discovery odds toward the 15,000-soldier guarantee and waits for promotion", () => {
    expect(game.trainingGeneralDiscoveryChance(0)).toBe(game.TRAINING_GENERAL_DISCOVERY_INITIAL_CHANCE);
    expect(game.trainingGeneralDiscoveryChance(10_000)).toBeGreaterThan(game.trainingGeneralDiscoveryChance(1_000));
    expect(game.trainingGeneralDiscoveryChance(15_000)).toBe(1);
    const now = 1_000_000;
    const state = joined(now);
    state.privatePlayers.a.pendingGeneralDiscoveries = [{
      id: "training:test-job", sourceKind: "training", sourceId: "test-job", accountId: "a", x: 1, y: 1,
      gender: "female", directionTags: [], initial: false, population: 1000, resourceGrade: "B", trainedSoldiers: 1000, createdAt: now
    }];
    const confirmed = game.applyIntent(state, { type: "confirm-general-discovery", discoveryId: "training:test-job", idempotencyKey: "confirm-discovery" }, { actorAccountId: "a", now });
    expect(confirmed.state.privatePlayers.a.pendingGeneralDiscoveries).toHaveLength(0);
    expect(confirmed.effects).toContainEqual(expect.objectContaining({ type: "general-generation-request", confirmed: true, sourceKind: "training" }));

    const declinedState = joined(now);
    declinedState.privatePlayers.a.pendingGeneralDiscoveries = [{ id: "neutral-battle:test", sourceKind: "neutral-battle", sourceId: "test", accountId: "a", x: 2, y: 2, gender: "female", directionTags: [], initial: false, population: 1000, resourceGrade: "B", createdAt: now }];
    const declined = game.applyIntent(declinedState, { type: "decline-general-discovery", discoveryId: "neutral-battle:test", idempotencyKey: "decline-discovery" }, { actorAccountId: "a", now });
    expect(declined.state.privatePlayers.a.pendingGeneralDiscoveries).toHaveLength(0);
    expect(declined.effects).not.toContainEqual(expect.objectContaining({ type: "general-generation-request" }));
  });

  it("uses Cookie-style exponential player costs and closes the legacy unlimited-general training entry", () => {
    const now = 1_000_000;
    let state = joined(now);
    const firstCost = game.powerTrainingCost(300, 0, 1);
    const secondCost = game.powerTrainingCost(300, 1, 1);
    expect(secondCost).toBeGreaterThan(firstCost);
    expect(secondCost / firstCost).toBeCloseTo(1.15, 1);
    const selfTraining = game.applyIntent(state, { type: "power-train", targetType: "player", levels: 2, idempotencyKey: "self-power" }, { actorAccountId: "a", now });
    const selfJob = selfTraining.state.jobs[selfTraining.result.jobId];
    expect(selfTraining.result.nextPower).toBeGreaterThan(500);
    state = game.settleWorld(selfTraining.state, selfJob.finishAt).state;
    expect(state.players.a.trainingLevel).toBe(2);
    expect(state.players.a.power).toBe(game.trainingPower(500, 2));

    state.players.a.gold = 100000;
    state = game.applyIntent(state, { type: "grant-general", generalId: "trainee", name: "青禾", gender: "female", setting: "善守城。", power: 500, discoveryId: "trainee", idempotencyKey: "grant-trainee" }, { actorAccountId: "a", authorityAccountId: "a", now: now + 1 }).state;
    expect(() => game.applyIntent(state, { type: "power-train", targetType: "general", targetId: "trainee", levels: 1, idempotencyKey: "general-power" }, { actorAccountId: "a", now: now + 2 })).toThrow(/五次/);
  });

  it("does not allow a deployed general to start power training", () => {
    const now = 1_000_000;
    let state = joined(now);
    state = game.applyIntent(state, { type: "grant-general", generalId: "guard", name: "守将", gender: "female", setting: "守土有方。", power: 500, discoveryId: "guard", idempotencyKey: "grant-guard" }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    state = game.applyIntent(state, { type: "deploy-general", generalId: "guard", idempotencyKey: "deploy-guard" }, { actorAccountId: "a", now: now + 1 }).state;
    expect(() => game.applyIntent(state, { type: "power-train", targetType: "general", targetId: "guard", levels: 1, idempotencyKey: "train-deployed" }, { actorAccountId: "a", now: now + 2 })).toThrow(/五次/);
    expect(() => game.applyIntent(state, { type: "cultivate-general", generalId: "guard", goldInvestment: 5000, materialId: "white", idempotencyKey: "cultivate-deployed" }, { actorAccountId: "a", now: now + 6 * game.HOUR })).toThrow(/部署/);
  });

  it("migrates legacy general settings into the separated profile without minimum-value measurements", () => {
    const general: any = { gender: "female", setting: "旧版将领的核心经历与性格。", power: 800 };
    game.ensureGeneralProfile(general);
    expect(general.coreSetting).toBe("旧版将领的核心经历与性格。");
    expect(general.setting).toBe(general.coreSetting);
    expect(general.appearanceSetting.length).toBeGreaterThan(40);
    expect(general.measurements).toEqual({ chestCm: 86, waistCm: 60, hipCm: 88 });
    expect(general.basePower).toBe(800);
    expect(general.trainingLevel).toBe(0);
  });

  it("rejects garrison-only marches until soldiers are confirmed into the field army", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const target = { x: (player.position.x + 2) % 64, y: player.position.y };
    const cellKey = `${player.position.x},${player.position.y}`;
    const garrisonBefore = state.cells[cellKey].soldiers;
    expect(garrisonBefore).toBeGreaterThan(0);
    expect(player.fieldArmySoldiers).toBe(0);
    expect(() => game.applyIntent(state, {
      type: "march", to: target, soldiers: 1, attack: false, idempotencyKey: "march-before-gather"
    }, { actorAccountId: "a", now })).toThrow(/请先确认征集/);
    expect(state.cells[cellKey].soldiers).toBe(garrisonBefore);
    expect(state.players.a.fieldArmySoldiers).toBe(0);
  });

  it("marches after gather confirmation and deducts soldiers only from the field army", () => {
    const now = 1_000_000;
    const state = joined(now);
    const player = state.players.a;
    const target = { x: (player.position.x + 2) % 64, y: player.position.y };
    const cellKey = `${player.position.x},${player.position.y}`;
    const garrisonBefore = state.cells[cellKey].soldiers;
    const gathered = game.applyIntent(state, {
      type: "gather-march", amount: 2, idempotencyKey: "gather-before-march"
    }, { actorAccountId: "a", now });
    expect(gathered.state.players.a.fieldArmySoldiers).toBe(2);
    expect(gathered.state.cells[cellKey].soldiers).toBe(garrisonBefore - 2);
    const beforeGold = gathered.state.players.a.gold;
    const march = game.applyIntent(gathered.state, {
      type: "march", to: target, soldiers: 1, attack: false, finishAt: 0, idempotencyKey: "march-after-gather"
    }, { actorAccountId: "a", now: now + 1 });
    const job = march.state.jobs[march.result.jobId];
    expect(job.finishAt).toBe(now + 1 + game.marchDurationMs(2));
    expect(march.state.players.a.gold).toBe(beforeGold - game.marchCost(2, 1));
    expect(march.state.players.a.fieldArmySoldiers).toBe(1);
    expect(march.state.cells[cellKey].soldiers).toBe(garrisonBefore - 2);
  });

  it("rejects a march immediately when a damaged local save has lost the player position", () => {
    const now = 1_000_000;
    const state = joined(now);
    delete state.players.a.position;
    expect(() => game.applyIntent(state, {
      type: "march", to: { x: 10, y: 10 }, soldiers: 1, attack: false, idempotencyKey: "damaged-position"
    }, { actorAccountId: "a", now })).toThrow(/玩家所在地横坐标/);
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

  it("keeps a deployed general's dialogue available at the same cell and preserves it when the player leaves", () => {
    const now = 1_000_000;
    let state = joined(now);
    state = game.applyIntent(state, {
      type: "grant-general", generalId: "deployed-chat", name: "青禾", gender: "female",
      setting: "善守城，重信义。", power: 500, discoveryId: "deployed-chat", idempotencyKey: "grant-deployed-chat"
    }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    state = game.applyIntent(state, {
      type: "deploy-general", generalId: "deployed-chat", idempotencyKey: "deploy-chat"
    }, { actorAccountId: "a", now: now + 1 }).state;
    const sameCellTalk = game.applyIntent(state, {
      type: "talk-general", generalId: "deployed-chat", topic: "守备如何？", idempotencyKey: "talk-deployed-same-cell"
    }, { actorAccountId: "a", now: now + 2 });
    expect(sameCellTalk.result.modelRequest.input.general.name).toBe("青禾");

    const location = { ...sameCellTalk.state.generals["deployed-chat"].location };
    sameCellTalk.state.generals["deployed-chat"].interactionHistory.push({
      accountId: "a", userText: "守备如何？", reply: "城防无虞。", narration: "她按住剑柄，向你颔首。"
    });
    sameCellTalk.state.players.a.position = { x: location.x === 63 ? 62 : location.x + 1, y: location.y };
    const projected = game.projectWorldState(sameCellTalk.state, "a", now + game.DIALOGUE_COOLDOWN_MS + 3);
    expect(projected.generals["deployed-chat"].interactionHistory.at(-1)).toMatchObject({ reply: "城防无虞。" });
    expect(projected.generals["deployed-chat"].location).toEqual(location);
    expect(() => game.applyIntent(sameCellTalk.state, {
      type: "talk-general", generalId: "deployed-chat", topic: "异地传讯", idempotencyKey: "talk-deployed-away"
    }, { actorAccountId: "a", now: now + game.DIALOGUE_COOLDOWN_MS + 3 })).toThrow(/当前位置/);
  });

  it("keeps platform account identifiers out of every model-facing dialogue and memory payload", () => {
    const now = 1_000_000;
    const formerId = "11111111-2222-4333-8444-555555555555";
    let state = joined(now);
    state.players[formerId] = { accountId: formerId, displayName: "旧主乙" };
    state = game.applyIntent(state, { type: "grant-general", generalId: "g", name: "青禾", gender: "female", setting: "善守城，重信义。", power: 500, discoveryId: "grant", idempotencyKey: "grant" }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    state.generals.g.masterHistory.unshift({ accountId: formerId, fromYear: 1, toYear: 2, reason: "旧部" });
    state.generals.g.captivityHistory.push({ captorAccountId: "a", formerMasterAccountId: formerId, year: 2 });
    state.generals.g.interactionHistory.push({ year: 2, accountId: formerId, speakerName: "旧主乙", kind: "ordinary", category: "speech", summary: "谈论旧事", emotion: "怀念", userText: "近来如何", reply: "尚好" });
    const dialogue = game.buildGeneralDialogueRequest(state, state.generals.g, state.players.a, "谈谈旧主", now + 1);
    const memory = game.buildGeneralMemoryUpdateRequest(state, state.generals.g, state.players.a, { userText: "谈谈旧主", reply: "我仍记得她。", idempotencyKey: "memory" }, now + 1);
    expect(JSON.stringify(dialogue.input)).not.toContain(formerId);
    expect(JSON.stringify(memory.input)).not.toContain(formerId);
    expect(dialogue.input.allowedFormerLords).toEqual([{ recipientKey: "former-lord-1", displayName: "旧主乙" }]);
    expect(dialogue.input.replyStyle).toContain("最多 180 个汉字");
    expect(dialogue.routing.formerLords).toEqual([{ recipientKey: "former-lord-1", accountId: formerId, displayName: "旧主乙" }]);
  });

  it("stores the player's display name in general memories and accepts annotated custom tags", () => {
    const now = 1_000_000;
    const base = game.createWorld({ seed: "tag-seed", seasonId: "season", startedAt: now, authorityAccountId: "a" });
    const joined = game.applyIntent(base, {
      type: "join", orientation: "women", displayName: "甲玩家", characterProfileId: "profile-a",
      characterTags: [{ tag: "温柔", note: "偏好成熟气质" }], initialGeneralWish: "一名可靠的良将", idempotencyKey: "annotated-join"
    }, { actorAccountId: "a", actorAccountName: "甲昵称", now }).state;
    expect(joined.privatePlayers.a.characterTags).toEqual(["温柔｜偏好成熟气质"]);
    const granted = game.applyIntent(joined, { type: "grant-general", generalId: "named", name: "青禾", gender: "female", setting: "善守城。", power: 400, discoveryId: "named", idempotencyKey: "named-grant" }, { actorAccountId: "a", authorityAccountId: "a", now });
    expect(granted.state.generals.named.memoryText).toContain("被甲玩家发掘并提拔");
    expect(granted.state.generals.named.memoryText).not.toContain("39404f0e");
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

  it("allows an attacking march to end on enemy territory", () => {
    const now = 1_000_000;
    const state = joined(now);
    const attacker = state.players.a;
    const from = { x: 10, y: 10 };
    const target = { x: 12, y: 10 };
    attacker.position = from;
    attacker.fieldArmySoldiers = 1_000;
    attacker.gold = 1_000_000;
    state.cells[`${from.x},${from.y}`] = { ownerAccountId: "a", soldiers: 0, generalIds: [] };
    state.cells["11,10"] = { ownerAccountId: null, soldiers: 0, generalIds: [] };
    state.cells[`${target.x},${target.y}`] = { ownerAccountId: "b", soldiers: 1, generalIds: [] };
    state.players.b = { accountId: "b", displayName: "乙", position: target, carriedGeneralIds: [], fieldArmySoldiers: 0 };

    const quote = game.marchQuote(state, "a", target, 1_000, [], true, now);
    expect(quote).toMatchObject({
      from, to: target, distance: 2,
      path: [{ x: 11, y: 10 }, target]
    });
    const march = game.applyIntent(state, {
      type: "march", to: target, soldiers: 1_000, attack: true, idempotencyKey: "enemy-endpoint"
    }, { actorAccountId: "a", now });
    expect(march.state.jobs[march.result.jobId].path).toEqual(quote.path);
    const settled = game.settleWorld(march.state, march.result.finishAt);
    expect(settled.state.players.a.position).toEqual(target);
    expect(settled.state.cells[`${target.x},${target.y}`].ownerAccountId).toBe("a");
    expect(settled.effects).toContainEqual(expect.objectContaining({ type: "battle-won", at: target, previousOwner: "b" }));
    expect(settled.effects).not.toContainEqual(expect.objectContaining({ type: "march-blocked" }));
  });

  it("only lets an army standing on newly hostile territory retrace its previous march", () => {
    const now = 1_000_000;
    let state = joined(now);
    const origin = { x: 10, y: 10 };
    const exposed = { x: 12, y: 10 };
    const diversion = { x: 12, y: 12 };
    state.players.a.position = origin;
    state.players.a.gold = 1_000_000;
    state.players.a.fieldArmySoldiers = 0;
    state.cells[`${origin.x},${origin.y}`] = { ownerAccountId: "a", soldiers: 0, generalIds: [] };
    state.cells["11,10"] = { ownerAccountId: null, soldiers: 0, generalIds: [] };
    state.cells[`${exposed.x},${exposed.y}`] = { ownerAccountId: null, soldiers: 0, generalIds: [] };

    const outward = game.applyIntent(state, {
      type: "march", to: exposed, soldiers: 0, attack: false, idempotencyKey: "enter-exposed-cell"
    }, { actorAccountId: "a", now });
    expect(outward.state.jobs[outward.result.jobId].path).toEqual([
      { x: 11, y: 10 }, exposed
    ]);
    state = game.settleWorld(outward.state, outward.result.finishAt).state;
    expect(state.players.a.position).toEqual(exposed);
    expect(state.players.a.retreatPath).toEqual([
      exposed, { x: 11, y: 10 }, origin
    ]);

    state.cells[`${exposed.x},${exposed.y}`] = { ownerAccountId: "b", soldiers: 1, generalIds: [] };
    state.cells[`${diversion.x},${diversion.y}`] = { ownerAccountId: null, soldiers: 0, generalIds: [] };
    for (const attack of [false, true]) {
      expect(() => game.marchQuote(state, "a", diversion, 0, [], attack, outward.result.finishAt + 1)).toThrow(/没有可通行的行军路径/);
      expect(() => game.applyIntent(state, {
        type: "march", to: diversion, soldiers: 0, attack, idempotencyKey: `hostile-diversion-${attack}`
      }, { actorAccountId: "a", now: outward.result.finishAt + 1 })).toThrow(/没有可通行的行军路径/);
    }

    const returnQuote = game.marchQuote(state, "a", origin, 0, [], false, outward.result.finishAt + 1);
    expect(returnQuote).toMatchObject({
      from: exposed, to: origin, distance: 2,
      path: [{ x: 11, y: 10 }, origin]
    });
    const returning = game.applyIntent(state, {
      type: "march", to: origin, soldiers: 0, attack: false, idempotencyKey: "retrace-to-origin"
    }, { actorAccountId: "a", now: outward.result.finishAt + 1 });
    expect(returning.state.jobs[returning.result.jobId].path).toEqual(returnQuote.path);
    const returned = game.settleWorld(returning.state, returning.result.finishAt);
    expect(returned.state.players.a.position).toEqual(origin);
    expect(returned.effects).toContainEqual(expect.objectContaining({ type: "march-arrived", at: origin }));
  });

  it("keeps gold, queued work and carried generals out of another player's projection", () => {
    const now = 1_000_000;
    let state = joined(now);
    const player = state.players.a;
    state = game.applyIntent(state, { type: "start-mining", x: player.position.x, y: player.position.y, auto: true, idempotencyKey: "private-mine" }, { actorAccountId: "a", now }).state;
    state = game.applyIntent(state, { type: "grant-general", generalId: "private-general", name: "青禾", gender: "female", setting: "善守城。", power: 500, discoveryId: "private", idempotencyKey: "private-general" }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    const publicState = game.projectWorldState(state, null);
    expect(publicState.authorityAccountId).toBe("a");
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

  it("supports public general market listings and prevents captive sales", () => {
    const now = 1_000_000;
    let state = game.createWorld({ seed: "market-seed", seasonId: "season", startedAt: now, authorityAccountId: "a" });
    for (const [accountId, displayName] of [["a", "甲"], ["b", "乙"]]) {
      state = game.applyIntent(state, {
        type: "join", orientation: "any", displayName, characterProfileId: `profile-${accountId}`,
        characterTags: ["勇敢"], initialGeneralWish: "一名可靠的良将", idempotencyKey: `join-${accountId}`
      }, { actorAccountId: accountId, actorAccountName: displayName, now }).state;
    }
    state = game.applyIntent(state, { type: "grant-general", generalId: "market-general", name: "青禾", gender: "female", setting: "善守城。", power: 700, discoveryId: "market", idempotencyKey: "grant-market" }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    const listed = game.applyIntent(state, { type: "list-general", generalId: "market-general", price: 123, sellerIntro: "善守城，愿寻识才之主。", idempotencyKey: "list-market" }, { actorAccountId: "a", now: now + 1 });
    state = listed.state;
    const listingId = Object.keys(state.marketListings)[0]!;
    expect(game.projectWorldState(state, "b").marketListings[listingId]).toMatchObject({ price: 123, sellerIntro: "善守城，愿寻识才之主。", general: { name: "青禾", power: 700, coreSetting: "善守城。" } });
    const cancelled = game.applyIntent(state, { type: "cancel-market-listing", listingId, idempotencyKey: "cancel-market" }, { actorAccountId: "a", now: now + 2 });
    expect(cancelled.result.relistAvailableAt).toBe(now + 2 + game.MARKET_RELIST_COOLDOWN_MS);
    expect(() => game.applyIntent(cancelled.state, { type: "list-general", generalId: "market-general", price: 456, idempotencyKey: "list-too-soon" }, { actorAccountId: "a", now: now + 3 })).toThrow(/等待/);
    const relisted = game.applyIntent(cancelled.state, { type: "list-general", generalId: "market-general", price: 123, sellerIntro: "善守城，愿寻识才之主。", idempotencyKey: "relist-market" }, { actorAccountId: "a", now: now + 2 + game.MARKET_RELIST_COOLDOWN_MS });
    const relistedId = Object.keys(relisted.state.marketListings)[0]!;
    const bought = game.applyIntent(relisted.state, { type: "buy-market-general", listingId: relistedId, idempotencyKey: "buy-market" }, { actorAccountId: "b", now: now + 2 + game.MARKET_RELIST_COOLDOWN_MS + 1 });
    expect(bought.state.marketListings).toEqual({});
    expect(bought.state.generals["market-general"]).toMatchObject({ holderAccountId: "b", status: "carried" });
    expect(bought.state.marketSales[bought.result.transactionId]).toMatchObject({ sellerAccountId: "a", buyerAccountId: "b", price: 123 });
    bought.state.generals["market-general"].status = "captured";
    expect(() => game.applyIntent(bought.state, { type: "list-general", generalId: "market-general", price: 456, idempotencyKey: "list-captive" }, { actorAccountId: "b", now: now + 3 })).toThrow(/不能上架/);
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
