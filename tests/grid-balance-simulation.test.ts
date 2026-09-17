import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type SimulationModule = {
  runSimulation: (options?: { seed?: string; players?: number; days?: number; miningModel?: "actual" | "legacy" | "proposed" }) => any;
  CULTIVATION_RANGES: readonly any[];
  BALANCE_BASELINE: { miningFormula: string };
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
    expect(first.config).toMatchObject({ days: 30, gridSize: 64, marchSecondsPerCell: 30 });
  });

  it("keeps cultivation gates and the fifth late-game range explicit", () => {
    expect(simulation.CULTIVATION_RANGES).toHaveLength(5);
    expect(simulation.CULTIVATION_RANGES.map((item: any) => item.gateHours)).toEqual([6, 48, 168, 360, 576]);
    expect(simulation.CULTIVATION_RANGES.every((item: any) => item.materialCount === 1)).toBe(true);
    const fifth = simulation.CULTIVATION_RANGES[4];
    expect(fifth).toMatchObject({ goldMin: 160000, goldMax: 240000, powerGainPctMin: 25, powerGainPctMax: 40 });
    expect(fifth.materialChoices).toEqual(["white", "green", "blue", "purple", "gold", "red-ascend", "red-reroll"]);
    expect(simulation.runSimulation().cultivation.totalGoldRange).toEqual({ min: 277000, max: 411000 });
  });

  it("reports resource cycles, two-decimal effects, and bounded talent potency", () => {
    const report = simulation.runSimulation({ seed: "resource-test" });
    expect(report.resources.cycleSecondsRange).toEqual({ min: 60, max: 3600 });
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
    expect(report.averages.firstCultivationGateHours).toBe(6);
    expect(report.cultivation.timeline[1].earliestHours).toBeGreaterThanOrEqual(6);
    expect(report.cultivation.timeline[1].playersCompletedAtGate).toBeGreaterThanOrEqual(0);
    expect(report.players.flatMap((player: any) => player.cultivation).every((item: any) => item.materialCount === 1)).toBe(true);
    expect(report.formulas.generalDiscovery).toContain("victorious neutral conquest");
    expect(report.availability.expectedGeneralsTotal).toBeGreaterThan(0);
    expect(report.availability.treasureSupplyTotal).toBe(240);
  });

  it("matches the implemented engine formula and measures six-hour affordability", () => {
    const report = simulation.runSimulation({ seed: "grid-balance-2026", players: 20, days: 30 });
    expect(simulation.CULTIVATION_RANGES.map((item: any) => [item.gateHours, item.goldMin, item.goldMax])).toEqual(
      engine.CULTIVATION_RANGES.map((item: any) => [item.gateHours, item.goldMin, item.goldMax])
    );
    expect(report.formulas.marchDuration).toBe("distanceCells * 30 seconds");
    expect(engine.marchDurationMs(8)).toBe(8 * 30_000);
    expect(report.resources.cycleSecondsRange).toEqual({ min: 60, max: 3600 });
    for (const [x, y] of [[0, 0], [7, 11], [31, 47], [63, 63]]) {
      const cell = engine.staticCell("grid-balance-2026", x, y);
      const hourly = (400 + cell.population * 0.09) * (1 + cell.resourceRank * 0.08);
      expect(engine.resourceYield(cell)).toBe(Math.max(1, Math.round(hourly * engine.resourceCycleMs(cell) / 3_600_000)));
    }
    expect(report.config.miningModel).toBe("actual");
    expect(report.resources.firstCultivationAffordability.mapAffordablePct).toBe(80.59);
    expect(report.resources.firstCultivationAffordability.timeToAffordHours.median).toBe(4.09);
    expect(report.resources.goldPerHourByGrade["S+"].median).toBeGreaterThan(report.resources.goldPerHourByGrade["D-"].median);
  });

  it("keeps the legacy inverted model only as a regression comparison", () => {
    const report = simulation.runSimulation({ seed: "grid-balance-2026", players: 20, days: 30, miningModel: "legacy" });
    expect(simulation.PROPOSED_MINING_BALANCE).toEqual({ baseHourlyGold: 400, populationHourlyFactor: 0.09, rankMultiplierPerLevel: 0.08 });
    expect(simulation.BALANCE_BASELINE.miningFormula).toContain("round");
    expect(report.config.miningModel).toBe("legacy");
    expect(report.resources.firstCultivationAffordability).toMatchObject({
      mapAffordablePct: 41.16,
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
