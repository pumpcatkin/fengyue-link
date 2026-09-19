import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");

const NOW = 1_000_000;

function cellKey(position: { x: number; y: number }) {
  return `${position.x},${position.y}`;
}

function marchingState({
  from = { x: 10, y: 10 },
  fieldArmySoldiers = 10,
  garrison = 5
}: {
  from?: { x: number; y: number };
  fieldArmySoldiers?: number;
  garrison?: number;
} = {}) {
  const state = game.createWorld({
    seed: "march-routing",
    seasonId: "season",
    startedAt: NOW,
    authorityAccountId: "a"
  });
  state.players.a = {
    accountId: "a",
    displayName: "甲",
    gold: 100_000,
    position: { ...from },
    fieldArmySoldiers,
    carriedGeneralIds: [],
    basePower: 500,
    trainingLevel: 0,
    power: 500,
    joinedAt: NOW
  };
  state.privatePlayers.a = { orientation: "any", characterTags: [] };
  state.cells[cellKey(from)] = { ownerAccountId: "a", soldiers: garrison, generalIds: [] };
  return state;
}

function ownSoldierTotal(state: any) {
  const garrison = Object.values(state.cells || {})
    .filter((cell: any) => cell?.ownerAccountId === "a")
    .reduce((sum: number, cell: any) => sum + Number(cell.soldiers || 0), 0);
  const fieldArmy = Number(state.players.a.fieldArmySoldiers || 0);
  const marching = Object.values(state.jobs || {})
    .filter((job: any) => job?.type === "march" && job?.accountId === "a")
    .reduce((sum: number, job: any) => sum + Number(job.soldiers || 0), 0);
  return garrison + fieldArmy + marching;
}

describe("authoritative march routing", () => {
  it("uses the shortest passable detour instead of crossing another player's territory", () => {
    const state = marchingState();
    const target = { x: 14, y: 10 };
    state.cells["12,10"] = { ownerAccountId: "b", soldiers: 30, generalIds: [] };

    const quote = game.marchQuote(state, "a", target, 10, [], false, NOW);
    expect(quote.distance).toBe(6);
    expect(quote.path).toHaveLength(6);
    expect(quote.path.at(-1)).toEqual(target);
    expect(quote.path).not.toContainEqual({ x: 12, y: 10 });
    expect(quote.path.every((point: any) => {
      const owner = state.cells[cellKey(point)]?.ownerAccountId;
      return owner == null || owner === "a";
    })).toBe(true);
    const routeWithOrigin = [{ x: 10, y: 10 }, ...quote.path];
    for (let index = 1; index < routeWithOrigin.length; index += 1) {
      const previous = routeWithOrigin[index - 1];
      const current = routeWithOrigin[index];
      expect(Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y)).toBe(1);
    }
    expect(quote.baseCost).toBe(game.marchCost(6, 10, 0));
    expect(quote.baseDurationMs).toBe(game.marchDurationMs(6));

    const started = game.applyIntent(state, {
      type: "march",
      to: target,
      soldiers: 10,
      attack: false,
      idempotencyKey: "shortest-detour"
    }, { actorAccountId: "a", now: NOW });
    expect(started.result.distance).toBe(6);
    expect(started.state.jobs[started.result.jobId].path).toEqual(quote.path);

    const settled = game.settleWorld(started.state, started.result.finishAt);
    expect(settled.state.players.a.position).toEqual(target);
    expect(settled.effects).toContainEqual(expect.objectContaining({
      type: "march-arrived",
      accountId: "a",
      at: target
    }));
    expect(settled.state.cells["12,10"]).toMatchObject({ ownerAccountId: "b", soldiers: 30 });
  });

  it("rejects a march when other players' territory completely seals every route", () => {
    const state = marchingState();
    const target = { x: 14, y: 10 };
    for (let y = 0; y < game.GRID_SIZE; y += 1) {
      state.cells[`12,${y}`] = { ownerAccountId: "b", soldiers: 1, generalIds: [] };
    }
    const before = structuredClone(state);

    expect(() => game.marchQuote(state, "a", target, 10, [], false, NOW)).toThrow(/路径|路线|抵达/);
    expect(() => game.applyIntent(state, {
      type: "march",
      to: target,
      soldiers: 10,
      attack: false,
      idempotencyKey: "sealed-route"
    }, { actorAccountId: "a", now: NOW })).toThrow(/路径|路线|抵达/);
    expect(state).toEqual(before);
  });

  it("charges the complete route when the shortest detour is longer than 126 cells", () => {
    const state = marchingState({ from: { x: 0, y: 1 }, fieldArmySoldiers: 0 });
    const target = { x: 62, y: 1 };
    for (let x = 1; x < 62; x += 2) {
      const gapY = ((x - 1) / 2) % 2 ? 63 : 0;
      for (let y = 0; y < game.GRID_SIZE; y += 1) {
        if (y !== gapY) state.cells[`${x},${y}`] = { ownerAccountId: "b", soldiers: 1, generalIds: [] };
      }
    }

    const quote = game.marchQuote(state, "a", target, 0, [], false, NOW);
    expect(quote.distance).toBeGreaterThan(126);
    expect(quote.path).toHaveLength(quote.distance);
    expect(quote.baseCost).toBe(quote.distance);
    expect(quote.baseDurationMs).toBe(quote.distance * game.MARCH_MS_PER_CELL);
    expect(quote.durationMs).toBe(quote.distance * game.MARCH_MS_PER_CELL);
    expect(game.marchCost(quote.distance, 0, 0)).toBe(quote.distance);
    expect(game.marchDurationMs(quote.distance)).toBe(quote.distance * game.MARCH_MS_PER_CELL);
  });

  it("returns every cancelled marching soldier to the field army without changing the origin garrison", () => {
    const state = marchingState({ fieldArmySoldiers: 25, garrison: 5 });
    const origin = { ...state.players.a.position };
    const originKey = cellKey(origin);
    const target = { x: origin.x + 1, y: origin.y };
    const totalBefore = ownSoldierTotal(state);

    const started = game.applyIntent(state, {
      type: "march",
      to: target,
      soldiers: 10,
      attack: false,
      idempotencyKey: "cancel-start"
    }, { actorAccountId: "a", now: NOW });
    expect(started.state.players.a.fieldArmySoldiers).toBe(15);
    expect(started.state.jobs[started.result.jobId].soldiers).toBe(10);
    expect(started.state.cells[originKey].soldiers).toBe(5);
    expect(ownSoldierTotal(started.state)).toBe(totalBefore);
    const goldAfterStart = started.state.players.a.gold;

    const cancelIntent = {
      type: "cancel-march",
      jobId: started.result.jobId,
      idempotencyKey: "cancel-finish"
    };
    const cancelled = game.applyIntent(started.state, cancelIntent, { actorAccountId: "a", now: NOW + 1 });

    expect(cancelled.result).toMatchObject({
      jobId: started.result.jobId,
      cancelled: true,
      returnedSoldiers: 10,
      refundedGold: 0
    });
    expect(cancelled.state.players.a.fieldArmySoldiers).toBe(25);
    expect(cancelled.state.cells[originKey].soldiers).toBe(5);
    expect(cancelled.state.players.a.position).toEqual(origin);
    expect(cancelled.state.jobs[started.result.jobId]).toBeUndefined();
    expect(cancelled.state.players.a.gold).toBe(goldAfterStart);
    expect(ownSoldierTotal(cancelled.state)).toBe(totalBefore);

    const duplicate = game.applyIntent(cancelled.state, cancelIntent, { actorAccountId: "a", now: NOW + 2 });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state.players.a.fieldArmySoldiers).toBe(25);
    expect(ownSoldierTotal(duplicate.state)).toBe(totalBefore);
  });

  it.each([
    ["friendly", { ownerAccountId: "a", soldiers: 7, generalIds: [] }],
    ["neutral", { ownerAccountId: null, soldiers: 0, generalIds: [] }]
  ])("keeps non-combat arrivals in the field army at a %s destination", (_kind, targetCell) => {
    const state = marchingState({ fieldArmySoldiers: 25, garrison: 5 });
    const target = { x: 11, y: 10 };
    state.cells[cellKey(target)] = { ...targetCell };
    const targetSoldiersBefore = state.cells[cellKey(target)].soldiers;

    const started = game.applyIntent(state, {
      type: "march",
      to: target,
      soldiers: 10,
      attack: false,
      idempotencyKey: `non-combat-${_kind}`
    }, { actorAccountId: "a", now: NOW });
    expect(started.state.players.a.fieldArmySoldiers).toBe(15);

    const settled = game.settleWorld(started.state, started.result.finishAt);
    expect(settled.state.players.a.position).toEqual(target);
    expect(settled.state.players.a.fieldArmySoldiers).toBe(25);
    expect(settled.state.cells[cellKey(target)].soldiers).toBe(targetSoldiersBefore);
    expect(settled.effects).toContainEqual(expect.objectContaining({
      type: "march-arrived",
      accountId: "a",
      fieldArmySoldiers: 25
    }));
  });

  it("does not create a soldier when a zero-soldier army wins a neutral battle", () => {
    const state = marchingState({ fieldArmySoldiers: 0, garrison: 5 });
    const target = { x: 11, y: 10 };
    state.players.a.basePower = 100_000;
    state.players.a.power = 100_000;

    const started = game.applyIntent(state, {
      type: "march",
      to: target,
      soldiers: 0,
      attack: true,
      idempotencyKey: "zero-soldier-neutral-battle"
    }, { actorAccountId: "a", now: NOW });
    const settled = game.settleWorld(started.state, started.result.finishAt);

    expect(settled.state.cells[cellKey(target)]).toMatchObject({ ownerAccountId: "a", soldiers: 0 });
    expect(settled.state.players.a.fieldArmySoldiers).toBe(0);
    expect(settled.effects).toContainEqual(expect.objectContaining({
      type: "battle-won",
      accountId: "a",
      soldiers: 0
    }));
  });
});
