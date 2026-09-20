import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/game.js", import.meta.url), "utf8");

function harness() {
  const labels: Record<string, any> = {};
  const node = () => ({
    value: "", dataset: {}, disabled: false, textContent: "", listeners: {} as Record<string, () => void>,
    classList: { toggle: vi.fn() }, setAttribute: vi.fn(), replaceChildren() {}, append() {},
    addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; }
  });
  for (const id of ["training-target", "training-preview", "start-power-training", "cultivation-material-field", "training-level",
    "cultivation-gold", "cultivation-material", "connection-retry", "connection-notice"]) labels[`#${id}`] = node();
  labels["#training-target"].value = "general:g";
  labels["#cultivation-material"].value = "white";
  const quote: any = { attempt: 1, remaining: 5, goldMin: 500, goldMax: 8000, experience: 100, experienceRequired: 100, experienceReady: true, modifiers: { cultivationCost: -0.2 } };
  const target = { value: "general:g", type: "general", id: "g", name: "测试将领", entity: { cultivationCount: 0, cultivationQuote: quote } };
  const context: any = {
    document: { querySelector: (id: string) => labels[id], createElement: node },
    powerTrainingTargets: () => [target], renderMaterials() {}, hostTime: () => 1000,
    ownPlayer: () => ({ gold: 100_000, materials: { white: 10 } }), formatNumber: (value: any) => String(value),
    formatDuration: String, sendIntent: vi.fn(), host: vi.fn(), pendingHostKeys: new Map(), payload: { status: "degraded" }
  };
  runInNewContext(source.slice(source.indexOf("function generalExperienceLabel("), source.indexOf("function battleReportMarker("))
    + source.slice(source.indexOf("function renderPowerTraining()"), source.indexOf("function marchAvailable()"))
    + source.slice(source.indexOf("function renderConnectionNotice()"), source.indexOf("function renderAll()"))
    + source.slice(source.indexOf('document.querySelector("#training-target").addEventListener'),
      source.indexOf('document.querySelector("#start-mining").addEventListener')), context);
  context.renderPowerTraining();
  return { context, labels, quote };
}

describe("cultivation controls", () => {
  it("renders fractional experience for legacy fields and numbers for the completed stage", () => {
    const { context } = harness();
    expect(context.generalExperienceLabel({ experience: 24.659, cultivationCount: 0 })).toBe("24.659 / 100");
    expect(context.generalExperienceLabel({ experience: 27, cultivationCount: 3 })).toBe("27 / 1800");
    expect(context.generalExperienceLabel({ experience: 0, cultivationCount: 5 })).toBe("0 / 0");
  });
  it("keeps a partial draft during sync and sends the exact completed budget", () => {
    const { context, labels } = harness();
    const input = labels["#cultivation-gold"];
    input.value = "15";
    input.listeners.input();
    context.renderPowerTraining();
    expect(input.value).toBe("15");
    expect(labels["#start-power-training"].disabled).toBe(true);
    input.value = "1500";
    input.listeners.input();
    context.renderPowerTraining();
    expect(input.value).toBe("1500");
    expect(labels["#training-preview"].textContent).toBe("经验 100 / 100");
    expect(labels["#training-preview"].textContent).not.toContain("实际消耗");
    labels["#start-power-training"].listeners.click();
    expect(context.sendIntent).toHaveBeenCalledWith({ type: "cultivate-general", generalId: "g", goldInvestment: 1500, materialId: "white" });
  });

  it.each([undefined, false, true])("checks both the explicit ready flag %s and numeric experience", ready => {
    const { context, labels, quote } = harness();
    quote.experienceReady = ready;
    quote.experience = 99;
    context.renderPowerTraining();
    expect(labels["#start-power-training"].disabled).toBe(true);
    labels["#start-power-training"].listeners.click();
    expect(context.sendIntent).not.toHaveBeenCalled();
    quote.experience = 100;
    context.renderPowerTraining();
    expect(labels["#start-power-training"].disabled).toBe(ready !== true);
  });

  it("resets the draft only when advancing to the next cultivation stage", () => {
    const { context, labels, quote } = harness();
    labels["#cultivation-gold"].value = "8000";
    quote.attempt = 2;
    quote.goldMin = 1200;
    context.renderPowerTraining();
    expect(labels["#cultivation-gold"].value).toBe("1200");
  });

  it("shows one small retry action, prevents double submission and hides on recovery", () => {
    const { context, labels } = harness();
    context.renderConnectionNotice();
    expect(labels["#connection-retry"].textContent).toBe("重试");
    labels["#connection-retry"].listeners.click();
    expect(context.host).toHaveBeenCalledWith("sync", {}, expect.objectContaining({ key: "sync", expectResult: true }));
    context.pendingHostKeys.set("sync", "request");
    context.renderConnectionNotice();
    labels["#connection-retry"].listeners.click();
    expect(context.host).toHaveBeenCalledTimes(1);
    expect(labels["#connection-retry"].disabled).toBe(true);
    expect(labels["#connection-retry"].textContent).toBe("重试中");
    context.pendingHostKeys.clear();
    context.payload.status = "ready";
    context.renderConnectionNotice();
    expect(labels["#connection-notice"].classList.toggle).toHaveBeenLastCalledWith("hidden", true);
    expect(labels["#connection-retry"].disabled).toBe(false);
  });
});
