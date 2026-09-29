import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { normalizeBudget, createBudget } = require("../electron/harness-budget.cjs");

describe("development point budget", () => {
  it("defaults to 80000, accepts higher integer limits and explicit unlimited", () => {
    expect(normalizeBudget()).toBe(80000);
    expect(normalizeBudget(90000)).toBe(90000);
    expect(normalizeBudget(900000000)).toBe(900000000);
    expect(normalizeBudget(null)).toBeNull();
    expect(normalizeBudget("unlimited")).toBeNull();
  });
  it.each([0, 79999, -1, 80000.5, "", true, Infinity, NaN])("rejects invalid budget %s", value => {
    expect(() => normalizeBudget(value)).toThrow("80000");
  });
  it("counts all attempts and stops before another billable call", () => {
    const budget = createBudget(80000);
    budget.record({ total: 30000 });
    budget.check();
    budget.record({ total: 55000 });
    expect(budget.snapshot()).toMatchObject({ spent: 85000, requests: 2, remaining: 0, exceeded: true });
    expect(() => budget.check()).toThrow("达到预算");
  });
  it("does not invent a zero charge when billing is missing", () => {
    const budget = createBudget(null);
    budget.record({ total: null });
    expect(budget.snapshot()).toMatchObject({ unknownCharges: 1, spent: 0 });
    expect(() => budget.check()).toThrow("未知费用");
  });
  it("keeps unlimited requests available and distinguishes real zero usage", () => {
    const budget = createBudget(null);
    budget.record({ total: 10000000 });
    budget.record({ total: 0 });
    expect(() => budget.check()).not.toThrow();
    expect(budget.snapshot()).toMatchObject({ spent: 10000000, remaining: null, requests: 2 });
  });
});
