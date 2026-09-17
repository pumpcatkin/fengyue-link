import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/game.js", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function validMapPosition("), source.indexOf("function drawMapTasks("));

function harness() {
  const jobs: Record<string, any> = {
    mine: { id: "mine", type: "mining", accountId: "self", x: 4, y: 7, auto: true, lastSettledAt: 1000, cycleMs: 60000, yieldPerCycle: 35 },
    train: { id: "train", type: "training", accountId: "self", x: 4, y: 7, finishAt: 91000, amount: 20 },
    hidden: { id: "hidden", type: "mining", accountId: "other", x: 6, y: 7 },
    power: { id: "power", type: "power-training", accountId: "self" }
  };
  const tooltip = {
    textContent: "", style: {} as Record<string, string>, offsetWidth: 220, offsetHeight: 110, hidden: true,
    children: [] as any[],
    append(child: any) { this.children.push(child); },
    classList: { add() { tooltip.hidden = true; }, remove() { tooltip.hidden = false; } }
  };
  const ctx: any = {
    payload: { world: { jobs } }, selected: { x: 8, y: 9 },
    ownAccountId: () => "self", ownPlayer: () => ({ position: { x: 4, y: 7 } }),
    dynamicCell: () => ({ soldiers: 90 }), fact: () => ({ garrisonCap: 100 }),
    hostTime: () => 1000, formatDuration: (ms: number) => `${Math.ceil(ms / 1000)}秒`, formatNumber: (n: number) => String(n),
    mapTaskOverlays: [], mapPointer: null, panState: null,
    canvas: {
      offsetWidth: 648, clientWidth: 640, clientHeight: 640, clientLeft: 4, clientTop: 4,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 648, height: 648 })
    },
    marchQuoteCache: null,
    document: { querySelector: (selector: string) => selector === "#march-soldiers" ? { value: "100" } : tooltip, querySelectorAll: () => [], createElement: () => ({}) },
    window: { innerWidth: 1440, innerHeight: 940 }
  };
  runInNewContext(helpers, ctx);
  ctx.mapTaskOverlays = ctx.buildMapTaskOverlays();
  return { ctx, jobs, tooltip };
}

describe("grid world map task overlays", () => {
  it("previews the same horizontal-then-vertical route and real-time duration as the game rules", () => {
    const { ctx } = harness();
    const route = ctx.mapTaskOverlays[0];
    expect(route).toMatchObject({ type: "march", preview: true, durationMs: 180000, cost: 66 });
    expect(route.points).toEqual([{ x: 4.5, y: 7.5 }, { x: 8.5, y: 7.5 }, { x: 8.5, y: 9.5 }]);
    expect(ctx.marchMapRoute({ x: 0, y: 0 }, { x: 63, y: 63 }).durationMs).toBe(126 * 30000);
    expect(ctx.marchMapRoute({ x: 4, y: 7 }, { x: 4, y: 7 })).toBeNull();
    for (const bad of [{ x: -1, y: 7 }, { x: 64, y: 7 }, { x: 1.5, y: 7 }, { x: NaN, y: 7 }, null]) {
      expect(ctx.marchMapRoute(bad, { x: 1, y: 1 })).toBeNull();
    }
    expect(ctx.mapTaskDescription(route)).toContain("预计耗时：180秒");
  });

  it("keeps the active route from its stored origin even after a different tile is selected", () => {
    const { ctx, jobs } = harness();
    jobs.army = { id: "army", type: "march", accountId: "self", from: { x: 2, y: 3 }, to: { x: 9, y: 3 }, finishAt: 121000, soldiers: 80, generalIds: ["g"] };
    ctx.selected = { x: 20, y: 20 };
    const routes = ctx.buildMapTaskOverlays().filter((item: any) => item.type === "march");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ preview: false, from: { x: 2, y: 3 }, to: { x: 9, y: 3 } });
    expect(ctx.mapTaskDescription(routes[0], 1000)).toContain("剩余：120秒");
    expect(ctx.mapTaskDescription(routes[0], 121000)).toContain("剩余：等待结算");
    delete jobs.army;
    expect(ctx.buildMapTaskOverlays()[0].preview).toBe(true);
  });

  it("shows only private local jobs, with mining top-left and training top-right", () => {
    const { ctx, jobs } = harness();
    const badges = ctx.mapTaskOverlays.filter((item: any) => item.type !== "march");
    expect(badges).toHaveLength(2);
    expect(badges[0]).toMatchObject({ type: "mining", x: 4.045, y: 7.045 });
    expect(badges[1]).toMatchObject({ type: "training", x: 4.575, y: 7.045 });
    expect(badges[0].x + badges[0].width).toBeLessThan(badges[1].x);
    delete jobs.mine;
    expect(ctx.buildMapTaskOverlays().some((item: any) => item.type === "mining")).toBe(false);
    ctx.ownPlayer = () => null;
    expect(ctx.buildMapTaskOverlays()).toEqual([]);
  });

  it("hit-tests both legs of the route and separate corner badges across zoom scales", () => {
    const { ctx } = harness();
    for (const scale of [12, 50, 150]) {
      expect(ctx.mapTaskAt({ x: 4.2, y: 7.2 }, scale).type).toBe("mining");
      expect(ctx.mapTaskAt({ x: 4.8, y: 7.2 }, scale).type).toBe("training");
      expect(ctx.mapTaskAt({ x: 7, y: 7.5 }, scale).type).toBe("march");
      expect(ctx.mapTaskAt({ x: 8.5, y: 8.5 }, scale).type).toBe("march");
      expect(ctx.mapTaskAt({ x: 6, y: 9 }, scale)).toBeNull();
    }
    expect(ctx.mapTaskAt(null, 50)).toBeNull();
    expect(ctx.mapTaskAt({ x: 4.2, y: 7.2 }, 0)).toBeNull();
  });

  it("updates remaining time without advancing the mining cycle before host settlement", () => {
    const { ctx } = harness();
    const mine = ctx.mapTaskOverlays.find((item: any) => item.type === "mining");
    expect(ctx.mapTaskDescription(mine, 1000)).toContain("本轮剩余：60秒");
    expect(ctx.mapTaskDescription(mine, 2000)).toContain("本轮剩余：59秒");
    expect(ctx.mapTaskDescription(mine, 90000)).toContain("本轮剩余：等待结算");
    expect(ctx.mapTaskDescription(mine)).toContain("本轮预计获得：35 金币");
    mine.job.lastSettledAt = 61000;
    expect(ctx.mapTaskDescription(mine, 90000)).toContain("本轮剩余：31秒");
    const train = ctx.mapTaskOverlays.find((item: any) => item.type === "training");
    expect(ctx.mapTaskDescription(train)).toContain("预计新增：10 士兵（计划 20 人，受驻军上限限制）");
  });

  it("excludes canvas borders from hit coordinates at every map scale", () => {
    const { ctx } = harness();
    expect(ctx.mapCanvasPoint(99, 55)).toBeNull();
    expect(ctx.mapCanvasPoint(103, 60)).toBeNull();
    expect(ctx.mapCanvasPoint(744, 60)).toBeNull();
    expect(ctx.mapCanvasPoint(104, 54)).toEqual({ x: 0, y: 0, pixelsPerCell: 10 });
    expect(ctx.mapCanvasPoint(149, 129)).toEqual({ x: 4.5, y: 7.5, pixelsPerCell: 10 });
    ctx.canvas.offsetWidth = 1288;
    ctx.canvas.clientWidth = ctx.canvas.clientHeight = 1280;
    ctx.canvas.getBoundingClientRect = () => ({ left: -500, top: -200, width: 1288, height: 1288 });
    expect(ctx.mapCanvasPoint(-406, -46)).toEqual({ x: 4.5, y: 7.5, pixelsPerCell: 20 });
  });

  it("refreshes a stationary hover, hides it for removed tasks and panning, and keeps it in view", () => {
    const { ctx, tooltip, jobs } = harness();
    ctx.mapPointer = { x: 146, y: 126 };
    ctx.renderMapTaskTooltip();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toContain("本轮剩余：60秒");
    ctx.hostTime = () => 2000;
    ctx.renderMapTaskTooltip();
    expect(tooltip.textContent).toContain("本轮剩余：59秒");
    expect(parseInt(tooltip.style.left || "")).toBeGreaterThanOrEqual(8);
    expect(parseInt(tooltip.style.top || "")).toBeGreaterThanOrEqual(8);
    ctx.panState = {};
    ctx.renderMapTaskTooltip();
    expect(tooltip.hidden).toBe(true);
    ctx.panState = null;
    delete jobs.mine;
    ctx.mapTaskOverlays = ctx.buildMapTaskOverlays();
    ctx.renderMapTaskTooltip();
    expect(tooltip.textContent).not.toContain("本轮剩余");
    ctx.selected = null;
    ctx.mapTaskOverlays = ctx.buildMapTaskOverlays();
    ctx.renderMapTaskTooltip();
    expect(tooltip.hidden).toBe(true);
    ctx.hideMapTaskTooltip();
    expect(ctx.mapPointer).toBeNull();
  });

  it("colors unaffordable route quotes without an early insufficient-gold warning", () => {
    const { ctx, tooltip } = harness();
    ctx.mapPointer = { x: 174, y: 129 };
    ctx.renderMapTaskTooltip();
    expect(tooltip.children.at(-1)).toMatchObject({ className: "route-cost unaffordable", textContent: "预计消耗：66 金币" });
    expect(tooltip.textContent).not.toContain("金币不足");
    ctx.ownPlayer = () => ({ gold: 500, position: { x: 4, y: 7 } });
    ctx.renderMapTaskTooltip();
    expect(tooltip.children.at(-1).className).toBe("route-cost");
  });
});
