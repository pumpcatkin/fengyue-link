import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { orderLoginCandidates } = require("../electron/login-failover.cjs");

describe("automatic login failover", () => {
  it("uses only reachable nodes in ascending measured latency order", () => {
    expect(orderLoginCandidates([
      { origin: "https://slow.example", online: true, latency: 420 },
      { origin: "https://offline.example", online: false, latency: 5 },
      { origin: "https://fast.example", online: true, latency: 35 }
    ])).toEqual([
      { origin: "https://fast.example", latency: 35 },
      { origin: "https://slow.example", latency: 420 }
    ]);
  });

  it("deduplicates redirected nodes and keeps their fastest measurement", () => {
    expect(orderLoginCandidates([
      { origin: "https://alias.example", finalOrigin: "https://node.example", online: true, latency: 90 },
      { origin: "https://node.example", online: true, latency: 60 },
      { origin: "", online: true, latency: 1 }
    ])).toEqual([{ origin: "https://node.example", latency: 60 }]);
  });
});
