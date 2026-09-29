"use strict";

const MIN_BUDGET = 80000;
function normalizeBudget(value = MIN_BUDGET) {
  if (value === null || value === "unlimited") return null;
  if (typeof value === "boolean" || value === "") throw new Error("开发预算至少为 80000 积分，或选择无上限");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < MIN_BUDGET) throw new Error("开发预算至少为 80000 积分，或选择无上限");
  return number;
}
function createBudget(value) {
  const limit = normalizeBudget(value);
  let spent = 0, requests = 0, unknownCharges = 0;
  const snapshot = () => ({ limit, spent, requests, unknownCharges, remaining: limit === null ? null : Math.max(0, limit - spent), exceeded: limit !== null && spent > limit });
  const check = () => {
    let message, code;
    if (unknownCharges) { code = "HARNESS_BILLING_UNKNOWN"; message = "平台未返回本次积分结算，开发已暂停以避免继续产生未知费用；候选已保存"; }
    else if (limit !== null && spent >= limit) { code = "HARNESS_BUDGET_EXHAUSTED"; message = `本轮开发已结算 ${spent} 积分，达到预算 ${limit} 积分；候选已保存`; }
    if (message) { const error = new Error(message); error.code = code; error.retryable = false; error.budget = snapshot(); throw error; }
  };
  return {
    snapshot, check,
    record(points) {
      requests++;
      const total = points?.total;
      if (total == null || String(total).trim() === "" || typeof total === "boolean" || !Number.isFinite(Number(total)) || Number(total) < 0) unknownCharges++;
      else spent = Math.round((spent + Number(total)) * 1000000) / 1000000;
      return snapshot();
    }
  };
}
module.exports = { MIN_BUDGET, normalizeBudget, createBudget };
