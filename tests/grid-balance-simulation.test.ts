import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type SimulationModule = {
  runSimulation: (options?: { seed?: string; players?: number; days?: number; miningModel?: "actual" | "legacy" | "proposed" }) => any;
  staticCell: (seed: string, x: number, y: number) => any;
  miningCooldownMs: (cell: { resourceRank: number }) => number;
  marchCost: (distance: number, soldiers: number, generalCount?: number) => number;
  generatedGeneralPower: (seed: string, accountId: string, sourceId?: string) => number;
  generatedPlayerPower: (seed: string, accountId: string) => number;
  CENTRAL_LAYER_MULTIPLIERS: readonly number[];
  CULTIVATION_RANGES: readonly any[];
  BALANCE_BASELINE: {
    miningFormula: string;
    miningCycleSeconds: { min: number; max: number };
    miningCooldownSeconds: { min: number; max: number };
    maxConcurrentMiningJobs: number;
    playerPower: { min: number; max: number };
    generalPower: { min: number; max: number };
    training: { costPerSoldier: number; durationBaseSeconds: number; durationPerSoldierSeconds: number; maxGarrisonPct: number };
  };
  PROPOSED_MINING_BALANCE: { baseHourlyGold: number; populationHourlyFactor: number; rankMultiplierPerLevel: number };
};
const simulation = require("../scripts/simulate-grid-balance.cjs") as SimulationModule;
const engine = require("../electron/grid-world-game.cjs");

describe("grid balance simulation", () => {
  it("is deterministic for a fixed seed and models the requested sample size", () => {
    const first = simulation.runSimulation({ seed: "test-seed", players: 20, days: 30 });
    const second = simulation.runSimulation({ seed: "test-seed", players: 20, days: 30 });
    expect(first).toEqual(second);
    expect(first.players).toHaveLength(20);
    expect(first.config).toMatchObject({ days: 30, gridSize: 64, marchSecondsPerCell: 15 });
  });

  it("keeps cultivation gates and the fifth late-game range explicit", () => {
    expect(simulation.CULTIVATION_RANGES).toHaveLength(5);
    expect(simulation.CULTIVATION_RANGES.map((item: any) => item.gateHours)).toEqual([0, 0, 0, 0, 0]);
    expect(simulation.CULTIVATION_RANGES.every((item: any) => item.materialCount === 1)).toBe(true);
    const fifth = simulation.CULTIVATION_RANGES[4];
    expect(fifth).toMatchObject({ goldMin: 16000, goldMax: 240000, powerGainPctMin: 13, powerGainPctMax: 20 });
    expect(fifth.materialChoices).toEqual(["white", "green", "blue", "purple", "gold", "red-ascend", "red-reroll"]);
    expect(simulation.runSimulation().cultivation.totalGoldRange).toEqual({ min: 27700, max: 411000 });
  });

  it("reports resource cycles, two-decimal effects, and bounded talent potency", () => {
    const report = simulation.runSimulation({ seed: "resource-test" });
    expect(report.resources.cycleSecondsRange).toEqual({ min: 600, max: 600 });
    expect(report.resources.cooldownSecondsRange).toEqual({ min: 3600, max: 14400 });
    expect(report.resources.maxConcurrentMiningJobs).toBe(3);
    expect(report.resources.cooldownSecondsByGrade["D-"]).toMatchObject({ min: 3600, max: 3600 });
    expect(report.resources.cooldownSecondsByGrade["S+"]).toMatchObject({ min: 14400, max: 14400 });
    expect(report.talent.progressCap).toBe(1000);
    expect(report.talent.percentEffects.red).toEqual({ min: 11, max: 16 });
    expect(report.talent.modifierCaps.combatPowerPct).toBe(60);
    expect(Number.isInteger(Math.round(report.totals.winRatePct * 100))).toBe(true);
    expect(report.materialBalance).toMatchObject({ source: "author-manual-scatter", automaticGeneration: false, defaultScatterCount: 240, defaultRedAscend: 0, defaultRedReroll: 0, requiredPerAttempt: 1, maximumRequiredPerPlayer: 5 });
    expect(Object.values(report.materialBalance.usedTotal).reduce((sum: number, count: any) => sum + count, 0)).toBe(
      report.players.reduce((sum: number, player: any) => sum + player.cultivationCompleted, 0)
    );
  });

  it("produces a usable discovery and treasure measurement instead of hidden nulls", () => {
    const report = simulation.runSimulation({ seed: "availability-test" });
    expect(report.totals.discoveredGenerals).toBeGreaterThanOrEqual(0);
    expect(report.totals.treasures).toBeGreaterThanOrEqual(0);
    expect(report.averages.firstCultivationGateHours).toBe(0);
    expect(report.cultivation.timeline[1].earliestHours).toBeGreaterThanOrEqual(6);
    expect(report.cultivation.timeline[1].playersCompletedAtGate).toBeGreaterThanOrEqual(0);
    expect(report.players.flatMap((player: any) => player.cultivation).every((item: any) => item.materialCount === 1)).toBe(true);
    expect(report.formulas.generalDiscovery).toContain("victorious neutral conquest");
    expect(report.availability.expectedGeneralsTotal).toBeGreaterThan(0);
    expect(report.availability.treasureSupplyTotal).toBe(240);
  });

  it("keeps the historical population roll and applies only the four central multipliers", () => {
    const seenLayers = new Set<number>();
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const cell = simulation.staticCell("layer-rules", x, y);
        expect(cell.populationBase).toBeGreaterThanOrEqual(100);
        expect(cell.populationBase).toBeLessThanOrEqual(10000);
        expect(cell.population).toBe(Math.round(cell.populationBase * cell.layerMultiplier));
        expect(cell.resourceMultiplier).toBe(cell.layerMultiplier);
        seenLayers.add(cell.layerMultiplier);
      }
    }
    expect([...seenLayers].sort((a, b) => a - b)).toEqual([1, 1.2, 1.5, 2]);
    expect(simulation.CENTRAL_LAYER_MULTIPLIERS).toEqual([1, 1.2, 1.5, 2]);
  });

  it("matches the implemented mining, march, and generated-general rules", () => {
    const report = simulation.runSimulation({ seed: "grid-balance-2026", players: 20, days: 30 });
    expect(simulation.CULTIVATION_RANGES.map((item: any) => [item.gateHours, item.goldMin, item.goldMax])).toEqual(
      engine.CULTIVATION_RANGES.map((item: any) => [item.gateHours, item.goldMin, item.goldMax])
    );
    expect(report.formulas.marchDuration).toBe("distanceCells * 15 seconds");
    expect(engine.marchDurationMs(8)).toBe(8 * 15_000);
    expect(report.resources.cycleSecondsRange).toEqual({ min: 600, max: 600 });
    expect(engine.resourceCycleMs({ resourceRank: 0 })).toBe(10 * 60_000);
    expect(engine.miningCooldownMs({ resourceRank: 0 })).toBe(54 * 60_000);
    expect(engine.miningCooldownMs({ resourceRank: 14 })).toBe(216 * 60_000);
    for (const [x, y] of [[0, 0], [7, 11], [31, 47], [63, 63]] as Array<[number, number]>) {
      const expected = engine.staticCell("grid-balance-2026", x, y);
      expect(simulation.staticCell("grid-balance-2026", x, y)).toMatchObject({
        populationBase: expected.populationBase,
        population: expected.population,
        layerMultiplier: expected.layerMultiplier,
        resourceRank: expected.resourceRank
      });
    }
    for (const [distance, soldiers, generals] of [[1, 0, 0], [3, 10, 2], [2, 11, 1]] as Array<[number, number, number]>) {
      expect(simulation.marchCost(distance, soldiers, generals)).toBe(engine.marchCost(distance, soldiers, generals));
    }
    expect(simulation.marchCost(1, 0, 0)).toBe(1);
    expect(simulation.marchCost(3, 10, 2)).toBe(18);
    expect(simulation.marchCost(2, 11, 1)).toBe(10);
    const stablePlayerPower = simulation.generatedPlayerPower("grid-balance-2026", "player");
    expect(stablePlayerPower).toBe(engine.generatedPlayerPower("grid-balance-2026", "player"));
    expect(stablePlayerPower).toBeGreaterThanOrEqual(80);
    expect(stablePlayerPower).toBeLessThanOrEqual(120);
    const stablePower = simulation.generatedGeneralPower("grid-balance-2026", "player", "source");
    expect(stablePower).toBe(engine.generatedGeneralPower("grid-balance-2026", "player", "source"));
    expect(stablePower).toBeGreaterThanOrEqual(125);
    expect(stablePower).toBeLessThanOrEqual(175);
    expect(simulation.generatedGeneralPower("grid-balance-2026", "player", "source")).toBe(stablePower);
    const sampledPowers = Array.from({ length: 100 }, (_, index) => simulation.generatedGeneralPower("grid-balance-2026", "player", `source-${index}`));
    expect(new Set(sampledPowers).size).toBeGreaterThan(20);
    expect(sampledPowers.every(power => power >= 125 && power <= 175)).toBe(true);
    expect(report.players.every((player: any) => player.discovery.initialGeneralPower >= 125 && player.discovery.initialGeneralPower <= 175)).toBe(true);
    expect(report.players.flatMap((player: any) => player.discovery.discoveredGeneralPowers).every((power: number) => power >= 125 && power <= 175)).toBe(true);
    expect(report.config.training).toMatchObject({ durationBaseSeconds: 5, durationPerSoldierSeconds: 0.5 });
    expect(report.formulas.training).toContain("5 + soldiers * 0.5 seconds");
    expect(report.config.miningModel).toBe("actual");
    expect(report.resources.firstCultivationAffordability.mapAffordablePct).toBe(100);
    expect(report.resources.firstCultivationAffordability.timeToAffordHours.median).toBe(0);
    expect(report.resources.yieldPerRunByGrade["S+"].median).toBeGreaterThan(report.resources.yieldPerRunByGrade["D-"].median);
  });

  it("keeps the legacy inverted model only as a regression comparison", () => {
    const report = simulation.runSimulation({ seed: "grid-balance-2026", players: 20, days: 30, miningModel: "legacy" });
    expect(simulation.PROPOSED_MINING_BALANCE).toEqual({ baseHourlyGold: 400, populationHourlyFactor: 0.09, rankMultiplierPerLevel: 0.08 });
    expect(simulation.BALANCE_BASELINE.miningFormula).toContain("round");
    expect(report.config.miningModel).toBe("legacy");
    expect(report.resources.firstCultivationAffordability).toMatchObject({
      mapAffordablePct: 100,
      strictlyIncreasesByRankAtSamePopulation: false
    });
    expect(report.resources.goldPerHourByGrade["D-"].median).toBeGreaterThan(report.resources.goldPerHourByGrade["S+"].median * 5);
  });

  it("keeps gold power and material talent effects independent", () => {
    const report = simulation.runSimulation({ seed: "separation-test" });
    for (const player of report.players) {
      for (const cultivation of player.cultivation) {
        const range = simulation.CULTIVATION_RANGES[cultivation.attempt - 1];
        expect(cultivation.gold).toBeGreaterThanOrEqual(range.goldMin);
        expect(cultivation.gold).toBeLessThanOrEqual(range.goldMax);
        expect(cultivation.powerGainPct).toBeGreaterThanOrEqual(range.powerGainPctMin);
        expect(cultivation.powerGainPct).toBeLessThanOrEqual(range.powerGainPctMax);
        expect(cultivation.talentProgress).toBeGreaterThan(0);
      }
    }
  });
});
