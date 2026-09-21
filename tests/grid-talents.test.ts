import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const talents = require("../electron/grid-talents.cjs");

describe("grid talent catalog", () => {
  it("contains 100+ semantically distinct definitions with one talent per general", () => {
    expect(talents.TALENT_CATALOG.length).toBeGreaterThanOrEqual(100);
    expect(new Set(talents.TALENT_CATALOG.map((item: any) => item.id)).size).toBe(talents.TALENT_CATALOG.length);
    for (const item of talents.TALENT_CATALOG) {
      expect(item.effects.length).toBeGreaterThan(0);
      expect(new Set(item.effects.map((effect: any) => effect.key)).size).toBeGreaterThan(0);
      expect(JSON.stringify(item)).not.toMatch(/[\uD800-\uDFFF]/);
    }
  });

  it("rolls and normalizes deterministically", () => {
    const first = talents.rollTalent("seed", "general-1");
    expect(first).toEqual(talents.rollTalent("seed", "general-1"));
    expect(first).toEqual(talents.normalizeTalent(first, "different-seed"));
    expect(talents.rollTalent("seed", "general-2")).not.toEqual(first);
    expect(talents.RARITIES.map((item: any) => item.id)).toEqual(["white", "green", "blue", "purple", "gold", "red"]);
    expect(first.potency).toBeGreaterThanOrEqual(0.008);
    expect(first.potency).toBeLessThanOrEqual(0.7);
    expect(first.potencyPercent).toBe(Number(first.potencyPercent.toFixed(2)));
    const sample = Array.from({ length: 5000 }, (_, index) => talents.rollTalent("distribution", `g-${index}`));
    expect(sample.filter(item => item.rarity === "white").length / sample.length).toBeGreaterThan(0.5);
    expect(sample.filter(item => item.rarity === "red").length / sample.length).toBeLessThan(0.001);

    const totalWeight = talents.RARITIES.reduce((sum: number, rarity: any) => sum + rarity.weight, 0);
    expect(Object.fromEntries(talents.RARITIES.map((rarity: any) => [rarity.id, rarity.weight / totalWeight]))).toEqual({
      white: 0.64, green: 0.24, blue: 0.09, purple: 0.0277, gold: 0.002, red: 0.0003
    });
    const observed = new Set(Array.from({ length: 5000 }, (_, index) => talents.rollTalent("all-rarities", `g-${index}`).rarity));
    expect(observed).toEqual(new Set(["white", "green", "blue", "purple", "gold", "red"]));
  });

  it("makes white useful and widens every rarity gap, with two-decimal descriptions", () => {
    const white = talents.normalizeTalent({ instanceId: "w", talentId: "swift-column", progress: 0 });
    const red = talents.normalizeTalent({ instanceId: "r", talentId: "swift-column", progress: 1000 });
    expect(red.potency / white.potency).toBeGreaterThan(80);
    expect(talents.describeTalent(white)).toMatch(/降低0\.80%/);
    expect(talents.describeTalent(red)).toMatch(/降低70\.00%/);
    expect(talents.RARITIES[0]).toMatchObject({ potencyMin: 0.008, potencyMax: 0.02 });
    for (let index = 1; index < talents.RARITIES.length; index += 1) {
      expect(talents.RARITIES[index].potencyMin).toBeGreaterThan(talents.RARITIES[index - 1].potencyMax);
    }
  });

  it("preserves the declared rarity of legacy talents that have no progress", () => {
    const oldRed = talents.normalizeTalent({ instanceId: "legacy-red", talentId: "swift-column", rarity: "red", potency: 0.11 });
    const oldWhite = talents.normalizeTalent({ instanceId: "legacy-white", talentId: "swift-column", rarity: "white", potency: 0.006 });
    expect(oldRed.rarity).toBe("red");
    expect(oldRed.progress).toBeGreaterThanOrEqual(700);
    expect(oldWhite.rarity).toBe("white");
    expect(oldWhite.progress).toBeLessThan(100);
  });

  it("applies finite conditional scope modifiers and clamps additive stacking", () => {
    const state = { seed: "state", cells: {}, generals: {} };
    const context = {
      action: "march", actorAccountId: "a", position: { x: 1, y: 1 },
      cell: { ownerAccountId: "a", population: 9000, resourceGrade: "A", terrain: "plain" },
      attacking: true, armySize: 5000,
      talents: [
        { generalId: "carried", holderAccountId: "a", status: "carried", talent: { instanceId: "c", talentId: "swift-column", progress: 1000 } },
        { generalId: "allied", holderAccountId: "a", status: "deployed", location: { x: 2, y: 2 }, talent: { instanceId: "a1", talentId: "relay-post", progress: 1000 } },
        { generalId: "hostile", holderAccountId: "a", status: "deployed", location: { x: 0, y: 0 }, talent: { instanceId: "h1", talentId: "border-forage", progress: 1000 } }
      ]
    };
    const result = talents.talentModifiers(state, context);
    expect(result.marchDuration).toBeLessThan(0);
    expect(result.marchDuration).toBeGreaterThanOrEqual(-0.9);
    expect(result.marchCost).toBe(0);
    expect(result.applied.length).toBe(2);
    const capped = talents.talentModifiers(state, {
      ...context,
      talents: Array.from({ length: 16 }, (_, index) => ({
        generalId: `g-${index}`, holderAccountId: "a", status: "carried",
        talent: { instanceId: `t-${index}`, talentId: "swift-column", progress: 1000 }
      }))
    });
    expect(capped.marchDuration).toBe(-0.9);
    expect(() => talents.talentModifiers(state, { ...context, action: "unknown" })).not.toThrow();
  });

  it("supports terrain, resource, population, neutral, attack, army-size and time predicates", () => {
    const evaluate = (talentId: string, extra: any = {}, status = "carried") => talents.talentModifiers({}, {
      action: "march", actorAccountId: "a", position: { x: 1, y: 1 },
      cell: { ownerAccountId: "a", terrain: "mountain", resourceGrade: "S", population: 9000 },
      attacking: true, armySize: 3000, hour: 23,
      talents: [{ talent: { instanceId: talentId, talentId, progress: 1000 }, holderAccountId: "a", status, location: { x: 2, y: 2 } }],
      ...extra
    });
    expect(evaluate("mountain-guide").marchDuration).toBeLessThan(0);
    expect(evaluate("rich-road-toll", { position: { x: 2, y: 2 } }, "deployed").marchCost).toBeLessThan(0);
    expect(evaluate("populous-staging", {}, "deployed").marchDuration).toBeLessThan(0);
    expect(evaluate("vanguard-step").marchDuration).toBeLessThan(0);
    expect(evaluate("grand-logistics").marchCost).toBeLessThan(0);
    expect(evaluate("night-march").marchDuration).toBeLessThan(0);
    const neutral = evaluate("neutral-survey", {
      cell: { ownerAccountId: null, terrain: "plain", resourceGrade: "C", population: 1000 }, neutral: true
    }, "deployed");
    expect(neutral.marchDuration).toBeLessThan(0);
    expect(evaluate("mountain-guide", { cell: { ownerAccountId: "a", terrain: "plain", resourceGrade: "S", population: 9000 } }).marchDuration).toBe(0);
  });

  it("keeps every catalog effect reachable with a matching scope and condition context", () => {
    const position = { x: 10, y: 10 };
    for (const definition of talents.TALENT_CATALOG) {
      for (const [effectIndex, effect] of definition.effects.entries()) {
        const ownSource = effect.scope !== "enemy-neighbor";
        const source = {
          generalId: `${definition.id}-${effectIndex}`,
          holderAccountId: ownSource ? "a" : "enemy",
          status: effect.scope === "carried" ? "carried" : "deployed",
          location: effect.scope === "own-tile" ? position : { x: 9, y: 10 },
          talent: { instanceId: `${definition.id}-${effectIndex}`, talentId: definition.id, progress: 1000 }
        };
        const cell: any = {
          ownerAccountId: effect.scope === "neighbor-hostile" ? "enemy" : "a",
          terrain: "plain", resourceGrade: "C", population: 4000, occupationCount: 1
        };
        const context: any = {
          action: effect.action, actorAccountId: "a", position, cell,
          attacking: false, armySize: 1000, hour: 12, discoveryKind: "", talents: [source]
        };
        for (const condition of effect.when) {
          if (condition.op === "terrain-in") cell.terrain = condition.values[0];
          else if (condition.op === "resource-rank-gte" || condition.op === "resource-rank-lte") cell.resourceGrade = condition.value;
          else if (condition.op === "population-gte" || condition.op === "population-lte") cell.population = condition.value;
          else if (condition.op === "occupation-count-lte") cell.occupationCount = condition.value;
          else if (condition.op === "neutral-is") {
            context.neutral = condition.value;
            cell.ownerAccountId = condition.value ? null : (effect.scope === "neighbor-hostile" ? "enemy" : "a");
          } else if (condition.op === "attacking-is") context.attacking = condition.value;
          else if (condition.op === "army-size-gte" || condition.op === "army-size-lte") context.armySize = condition.value;
          else if (condition.op === "discovery-kind-is") context.discoveryKind = condition.value;
          else if (condition.op === "hour-between") context.hour = condition.start;
        }
        const result = talents.talentModifiers({}, context);
        if (!result.applied.some((item: any) => item.talentId === definition.id && item.effectIndex === effectIndex)) {
          throw new Error(`天赋效果没有可达路径：${definition.id}#${effectIndex}`);
        }
      }
    }
  });

  it("does not drop a relevant talent after sixteen unrelated sources", () => {
    const unrelated = Array.from({ length: 16 }, (_, index) => ({
      generalId: `unrelated-${index}`, holderAccountId: "a", status: "deployed", location: { x: 30, y: 30 },
      talent: { instanceId: `unrelated-${index}`, talentId: "swift-column", progress: 1000 }
    }));
    const result = talents.talentModifiers({}, {
      action: "march", actorAccountId: "a", position: { x: 1, y: 1 },
      cell: { ownerAccountId: "a", terrain: "plain", resourceGrade: "C", population: 4000 },
      talents: [...unrelated, {
        generalId: "relevant", holderAccountId: "a", status: "carried",
        talent: { instanceId: "relevant", talentId: "swift-column", progress: 1000 }
      }]
    });
    expect(result.evaluatedTalents).toBe(17);
    expect(result.marchDuration).toBeLessThan(0);
    expect(result.applied).toContainEqual(expect.objectContaining({ generalId: "relevant", talentId: "swift-column" }));
  });

  it("describes former cultivation-yield talents as experience gain without single-effect cap drift", () => {
    const changed = [
      "focused-cultivation", "mountain-retreat", "river-breathing", "academy-city", "rich-elixirs",
      "midnight-study", "neighbor-lecture", "frontier-tempering", "measured-progress", "garrison-mentor"
    ];
    for (const talentId of changed) {
      const definition = talents.TALENT_BY_ID[talentId];
      expect(definition.effects.some((effect: any) => effect.key === "experienceGain")).toBe(true);
      expect(definition.effects.some((effect: any) => effect.key === "cultivationPower")).toBe(false);
      expect(talents.describeTalent({ instanceId: talentId, talentId, progress: 1000 })).toContain("经验获取率");
    }
    for (const definition of talents.TALENT_CATALOG) {
      for (const effect of definition.effects) {
        const amount = 0.7 * Math.abs(effect.scale) * (effect.scope === "carried" ? 1 : talents.DEPLOYED_EFFECT_MULTIPLIER);
        const [minimum, maximum] = talents.MODIFIER_LIMITS[effect.key];
        expect(amount).toBeLessThanOrEqual(effect.scale < 0 ? Math.abs(minimum) : maximum);
      }
    }
  });

  it("upgrades through thresholds, ascends immediately, and rerolls without guaranteeing red", () => {
    const base = talents.normalizeTalent({ instanceId: "u", talentId: "swift-column", progress: 95 });
    let growth = base;
    for (const material of ["white", "green", "blue", "purple", "gold"]) {
      const upgraded = talents.upgradeTalent(growth, material);
      expect(upgraded.talent.progress).toBeGreaterThan(growth.progress);
      expect(upgraded.talent.potency).toBeGreaterThan(growth.potency);
      growth = upgraded.talent;
    }
    const green = talents.upgradeTalent(base, "green", { seed: "growth", nonce: 0 });
    expect(green.talent.rarity).toBe("green");
    expect(green.progressDelta).toBeGreaterThanOrEqual(18);
    expect(green.progressDelta).toBeLessThanOrEqual(22);
    const red = talents.upgradeTalent(green.talent, "red-ascend", { seed: "ascend" });
    expect(red.talent.rarity).toBe("red");
    const reroll = talents.upgradeTalent(red.talent, "red-reroll", { seed: "reroll", nonce: 1 });
    expect(reroll.talent.talentId).not.toBe(red.talent.talentId);
    expect(["white", "green", "blue", "purple", "gold", "red"]).toContain(reroll.talent.rarity);
  });

  it("uses stable nonce-bound material growth without touching character power", () => {
    const source: any = { instanceId: "stable-growth", talentId: "swift-column", progress: 300, power: 777 };
    const first = talents.upgradeTalent(source, "gold", { seed: "world-seed", nonce: 1 });
    const repeated = talents.upgradeTalent(source, "gold", { seed: "world-seed", nonce: 1 });
    const nextNonce = talents.upgradeTalent(source, "gold", { seed: "world-seed", nonce: 2 });
    expect(repeated).toEqual(first);
    expect(first.rolledProgressDelta).toBeGreaterThanOrEqual(Math.round(135 * 0.9));
    expect(first.rolledProgressDelta).toBeLessThanOrEqual(Math.round(135 * 1.1));
    expect(nextNonce.rolledProgressDelta).not.toBe(first.rolledProgressDelta);
    expect(source.power).toBe(777);
    expect(first.talent.power).toBeUndefined();
  });
});
