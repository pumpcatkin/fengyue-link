import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { nameServerCard } = require("../scripts/name-grid-server-cards.cjs");
const { createBundledGridCard, rebindGameCard, validateGameCard } = require("../electron/online-world-card.cjs");

describe("numbered grid server cards", () => {
  it("assigns all five names by work identity and preserves configuration and routing", () => {
    const works = [
      "faeaacf3-8c3a-4338-b2a2-8b704633ebf1",
      "23864aac-f916-4214-b051-40ae82b962ca",
      "67588ef2-2d5d-4a7c-8935-08f8d1cde083",
      "26ac5c7e-b504-41f6-b956-047a422d846b",
      "6cc9974b-39d0-4cee-b041-20f4f78e5dc6"
    ];
    const base = createBundledGridCard();
    for (const [index, work] of works.entries()) {
      const card = rebindGameCard(base, work);
      const named = nameServerCard(card, "2026-09-26T13:00:00.000Z");
      expect(named.title).toBe(`猎艳疆土(${index + 1}服)`);
      expect(named.companion).toEqual(card.companion);
      expect(named.program).toEqual(card.program);
      expect(named.cardId).toBe(card.cardId);
      expect(validateGameCard(named).packageSha256).toBe(named.packageSha256);
      expect(nameServerCard(named)).toBe(named);
    }
  });

  it("leaves other works and custom cards alone", () => {
    const card = rebindGameCard(createBundledGridCard(), "11111111-2222-3333-4444-555555555555");
    expect(nameServerCard(card)).toBe(card);
    const custom = { cardId: "custom.game", companion: { workId: "faeaacf3-8c3a-4338-b2a2-8b704633ebf1" } };
    expect(nameServerCard(custom)).toBe(custom);
  });
});
