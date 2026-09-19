import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const game = require("../electron/grid-world-game.cjs");
const talentEngine = require("../electron/grid-talents.cjs");

function key(x: number, y: number) {
  return `${x},${y}`;
}

function join(state: any, accountId: string, now: number) {
  return game.applyIntent(state, {
    type: "join",
    orientation: "any",
    displayName: accountId,
    characterProfileId: `profile-${accountId}`,
    characterTags: ["冷静"],
    initialGeneralWish: "一名可靠的良将",
    idempotencyKey: `join-${accountId}`
  }, { actorAccountId: accountId, now }).state;
}

describe("grid map layout rules", () => {
  it("derives four deterministic centre layers and the requested population/resource multipliers", () => {
    expect(game.centralLayer(31, 31)).toBe(4);
    expect(game.centralLayer(23, 23)).toBe(3);
    expect(game.centralLayer(15, 15)).toBe(2);
    expect(game.centralLayer(0, 0)).toBe(1);
    expect([1, 2, 3, 4].map(game.centralLayerColor)).toEqual(["frontier", "lowlands", "heartland", "core"]);
    expect(game.isCentralNeutralCell(31, 31)).toBe(true);
    expect(game.isCentralNeutralCell(29, 33)).toBe(true);
    expect(game.isCentralNeutralCell(28, 33)).toBe(false);
    expect(game.normalizedCenterDistances(31, 31).chebyshev).toBeLessThan(game.normalizedCenterDistances(0, 0).chebyshev);
    expect(game.normalizedCenterDistances(31, 31).manhattan).toBeLessThan(game.normalizedCenterDistances(0, 0).manhattan);
    expect(game.CENTRAL_LAYER_MULTIPLIERS).toEqual([1, 1.2, 1.5, 2]);

    for (const [x, y] of [[31, 31], [23, 23], [15, 15], [0, 0]]) {
      const cell = game.staticCell("layer-seed", x, y);
      expect(cell.layerMultiplier).toBe(game.CENTRAL_LAYER_MULTIPLIERS[cell.centralLayer - 1]);
      expect(cell.populationMultiplier).toBe(cell.layerMultiplier);
      expect(cell.resourceMultiplier).toBe(cell.layerMultiplier);
      expect(cell.population).toBe(Math.round(cell.populationBase * cell.populationMultiplier));
      expect(cell.population).toBeGreaterThanOrEqual(100);
      expect(cell.population).toBeLessThanOrEqual(20000);
    }
    const frontier = game.staticCell("layer-seed", 0, 0);
    expect(frontier.population).toBe(frontier.populationBase);
    expect(frontier.population).toBeGreaterThanOrEqual(100);
    expect(frontier.population).toBeLessThanOrEqual(10000);
  });

  it("places capitals near the edge and keeps the surrounding 5x5 neutral", () => {
    const now = 1_000_000;
    let state = game.createWorld({ seed: "capital-layout", seasonId: "season", startedAt: now, authorityAccountId: "a" });
    state = join(state, "a", now);
    const first = state.players.a.position;
    const edgeDistance = Math.min(first.x, first.y, game.GRID_SIZE - 1 - first.x, game.GRID_SIZE - 1 - first.y);
    expect(edgeDistance).toBeLessThan(game.SPAWN_EDGE_BAND);
    for (let dy = -game.SPAWN_NEUTRAL_RADIUS; dy <= game.SPAWN_NEUTRAL_RADIUS; dy += 1) {
      for (let dx = -game.SPAWN_NEUTRAL_RADIUS; dx <= game.SPAWN_NEUTRAL_RADIUS; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const x = first.x + dx;
        const y = first.y + dy;
        if (x >= 0 && y >= 0 && x < game.GRID_SIZE && y < game.GRID_SIZE) {
          expect(state.cells[key(x, y)]?.ownerAccountId || null).toBe(null);
        }
      }
    }

    state = join(state, "b", now + 1);
    const second = state.players.b.position;
    expect(second).not.toEqual(first);
    for (const position of [first, second]) {
      for (let dy = -game.SPAWN_NEUTRAL_RADIUS; dy <= game.SPAWN_NEUTRAL_RADIUS; dy += 1) {
        for (let dx = -game.SPAWN_NEUTRAL_RADIUS; dx <= game.SPAWN_NEUTRAL_RADIUS; dx += 1) {
          const x = position.x + dx;
          const y = position.y + dy;
          if (x >= 0 && y >= 0 && x < game.GRID_SIZE && y < game.GRID_SIZE) {
            const owner = state.cells[key(x, y)]?.ownerAccountId;
            expect(owner == null || owner === (x === position.x && y === position.y ? (position === first ? "a" : "b") : null)).toBe(true);
          }
        }
      }
    }
  });

  it("spreads capitals across the frontier layer instead of filling one border ring", () => {
    const now = 1_000_000;
    let state = game.createWorld({ seed: "frontier-spread", seasonId: "season", startedAt: now, authorityAccountId: "owner" });
    for (let index = 0; index < 24; index += 1) state = join(state, `player-${index}`, now + index);
    const positions = Object.values(state.players).map((player: any) => player.position);
    expect(positions.every((position: any) => game.centralLayer(position.x, position.y) === 1)).toBe(true);
    const edgeDistances = positions.map((position: any) => Math.min(position.x, position.y, game.GRID_SIZE - 1 - position.x, game.GRID_SIZE - 1 - position.y));
    expect(new Set(edgeDistances).size).toBeGreaterThan(2);
  });

  it("moves inward only after the outer layer has no valid neutral 5x5 area", () => {
    const state = game.createWorld({ seed: "capital-fallback", seasonId: "season", startedAt: 1_000_000, authorityAccountId: "owner" });
    for (let y = 0; y < game.GRID_SIZE; y += 1) for (let x = 0; x < game.GRID_SIZE; x += 1) {
      if (game.centralLayer(x, y) === 1) state.cells[key(x, y)] = { ownerAccountId: "other", soldiers: 0, generalIds: [] };
    }
    const before = structuredClone(state);
    const capital = game.chooseCapital(state, "new-player");
    expect(game.chooseCapital(state, "new-player")).toEqual(capital);
    expect(state).toEqual(before);
    expect(game.centralLayer(capital.x, capital.y)).toBe(2);
    for (let dy = -game.SPAWN_NEUTRAL_RADIUS; dy <= game.SPAWN_NEUTRAL_RADIUS; dy += 1) {
      for (let dx = -game.SPAWN_NEUTRAL_RADIUS; dx <= game.SPAWN_NEUTRAL_RADIUS; dx += 1) {
        expect(state.cells[key(capital.x + dx, capital.y + dy)]?.ownerAccountId || null).toBe(null);
      }
    }
  });

  it("applies a carried march-cost talent to the authoritative gold quote", () => {
    const now = 1_000_000;
    let state = game.createWorld({ seed: "march-talent", seasonId: "season", startedAt: now, authorityAccountId: "a" });
    state = join(state, "a", now);
    state = game.applyIntent(state, {
      type: "grant-general", generalId: "quartermaster", name: "军需官", gender: "female",
      setting: "善理军需。", power: 500, discoveryId: "quartermaster", idempotencyKey: "grant-quartermaster"
    }, { actorAccountId: "a", authorityAccountId: "a", now }).state;
    state.generals.quartermaster.talent = talentEngine.normalizeTalent({
      instanceId: "quartermaster", talentId: "lean-baggage", progress: 1000
    });
    expect(talentEngine.describeTalent(state.generals.quartermaster.talent)).toContain("行军金币消耗降低");
    const from = state.players.a.position;
    const to = { x: from.x < game.GRID_SIZE - 1 ? from.x + 1 : from.x - 1, y: from.y };
    const withTalent = game.marchQuote(state, "a", to, 100, [], false, now);
    const appliedState = structuredClone(state);
    appliedState.players.a.gold = 10_000;
    appliedState.players.a.fieldArmySoldiers = 100;
    const applied = game.applyIntent(appliedState, {
      type: "march", to, soldiers: 100, attack: false, idempotencyKey: "discounted-march"
    }, { actorAccountId: "a", now });
    expect(10_000 - applied.state.players.a.gold).toBe(withTalent.cost);
    state.generals.quartermaster.talent = talentEngine.normalizeTalent({
      instanceId: "quartermaster", talentId: "recruiting-office", progress: 1000
    });
    const withoutTalent = game.marchQuote(state, "a", to, 100, [], false, now);
    expect(withTalent.modifiers.marchCost).toBeLessThan(0);
    expect(withTalent.cost).toBe(Math.round(withTalent.baseCost * (1 + withTalent.modifiers.marchCost)));
    expect(withTalent.cost).toBeLessThan(withoutTalent.cost);
  });

  it("charges each cell for soldiers and every carried general while only two remain combat-active", () => {
    const now = 1_000_000;
    let state = game.createWorld({ seed: "march-cost", seasonId: "season", startedAt: now, authorityAccountId: "a" });
    state = join(state, "a", now);
    for (let index = 0; index < 3; index += 1) {
      const id = `g${index}`;
      state.generals[id] = game.createFallbackGeneral({ id, name: id, gender: "female", power: 300, holderAccountId: "a", holderName: "a" });
      state.players.a.carriedGeneralIds.push(id);
    }
    const from = state.players.a.position;
    const to = { x: from.x < game.GRID_SIZE - 2 ? from.x + 2 : from.x - 2, y: from.y };
    const quote = game.marchQuote(state, "a", to, 11, [], false, now);
    expect(quote.baseCost).toBe(quote.distance * (1 + 2 + 3 * 2));
    expect(quote.generalIds).toHaveLength(3);
    expect(quote.activeGeneralIds).toHaveLength(2);
  });
});
