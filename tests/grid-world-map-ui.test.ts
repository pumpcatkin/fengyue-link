import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/game.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/styles.css", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function validMapPosition("), source.indexOf("function drawMapTasks("));

function harness() {
  const jobs: Record<string, any> = {
    mine: { id: "mine", type: "mining", accountId: "self", x: 4, y: 7, auto: false, startedAt: 1000, lastSettledAt: 1000, finishAt: 601000, cycleMs: 600000, yieldPerCycle: 35 },
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
    ownAccountId: () => "self", ownPlayer: () => ({ position: { x: 4, y: 7 }, fieldArmySoldiers: 100, carriedGeneralIds: [] }),
    dynamicCell: () => ({ soldiers: 90 }), fact: () => ({ garrisonCap: 100 }),
    garrisonCapAt: () => 100,
    hostTime: () => 1000, formatDuration: (ms: number) => `${Math.ceil(ms / 1000)}秒`, formatNumber: (n: number) => String(n),
    mapTaskOverlays: [], mapPointer: null, panState: null,
    canvas: {
      offsetWidth: 648, clientWidth: 640, clientHeight: 640, clientLeft: 4, clientTop: 4,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 648, height: 648 })
    },
    marchQuoteCache: null, marchConfirmationTarget: null,
    document: { querySelector: () => tooltip, querySelectorAll: () => [], createElement: () => ({}) },
    window: { innerWidth: 1440, innerHeight: 940 }
  };
  runInNewContext(helpers, ctx);
  ctx.mapTaskOverlays = ctx.buildMapTaskOverlays();
  return { ctx, jobs, tooltip };
}

describe("grid world map task overlays", () => {
  it("centers only the map when selecting either report type and leaves the selected cell unchanged", () => {
    const centered: any[] = [];
    const report = { id: "loss", kind: "territory-loss", target: { x: 16, y: 0 } };
    const context: any = {
      activeBattleReportId: null, selected: { x: 1, y: 1 }, battleReportGeneralPickerOpen: true,
      battleReportById: (id: string) => id === report.id ? report : null,
      renderBattleReports: () => {}, centerMap: (position: any) => centered.push(position)
    };
    runInNewContext(source.slice(source.indexOf("function selectBattleReport("), source.indexOf("function closeBattleReport(")), context);
    context.selectBattleReport("loss");
    expect(context.activeBattleReportId).toBe("loss");
    expect(centered).toEqual([report.target]);
    expect(context.selected).toEqual({ x: 1, y: 1 });
    expect(context.battleReportGeneralPickerOpen).toBe(false);
    context.selectBattleReport("missing");
    expect(centered).toHaveLength(1);
    expect(source).toContain("requested + trainingPower(player)");
    expect(css).toMatch(/\.battle-report-navigation button \{[^}]*width: 44px; height: 44px/);
  });

  it("keeps mottled tile colors while darkening the central layers", () => {
    const colorSource = source.slice(source.indexOf("function tileColorHash"), source.indexOf("function validMapPosition"));
    const context: any = { ownAccountId: () => "self" };
    runInNewContext(colorSource, context);
    const colors = [] as string[];
    const ownedColors = [] as string[];
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
      colors.push(context.ownerColor(null, (x + y) % 15, 1, x, y));
      ownedColors.push(context.ownerColor("self", (x + y) % 15, 1, x, y));
    }
    expect(new Set(colors).size).toBeGreaterThan(1);
    expect(new Set(ownedColors).size).toBeGreaterThan(1);
    const luminance = (hex: string) => {
      const channels = (hex.slice(1).match(/../g) || []).map((value: string) => parseInt(value, 16));
      const [red = 0, green = 0, blue = 0] = channels;
      return red * .2126 + green * .7152 + blue * .0722;
    };
    const neutralOuter = context.ownerColor(null, 7, 0, 11, 17);
    const neutralCore = context.ownerColor(null, 7, 3, 11, 17);
    const ownedOuter = context.ownerColor("self", 7, 0, 11, 17);
    const ownedCore = context.ownerColor("self", 7, 3, 11, 17);
    expect(luminance(neutralCore)).toBeLessThan(luminance(neutralOuter));
    expect(luminance(ownedCore)).toBeLessThan(luminance(ownedOuter));
  });

  it("uses a restrained blue palette to distinguish owned territory from green land", () => {
    const colorSource = source.slice(source.indexOf("function tileColorHash"), source.indexOf("function validMapPosition"));
    const context: any = { ownAccountId: () => "self" };
    runInNewContext(colorSource, context);
    const rgb = (hex: string) => (hex.slice(1).match(/../g) || []).map((value: string) => parseInt(value, 16));

    for (let layer = 0; layer < 4; layer += 1) {
      const [neutralRed = 0, neutralGreen = 0, neutralBlue = 0] = rgb(context.ownerColor(null, 7, layer, 11, 17));
      const [ownedRed = 0, ownedGreen = 0, ownedBlue = 0] = rgb(context.ownerColor("self", 7, layer, 11, 17));
      expect(ownedBlue - ownedRed).toBeGreaterThan(35);
      expect(neutralGreen - neutralBlue).toBeGreaterThan(15);
      expect(Math.abs(ownedBlue - neutralBlue) + Math.abs(ownedRed - neutralRed)).toBeGreaterThan(80);
    }

    expect(css).toMatch(/\.legend \.mine\s*\{\s*background:\s*#6993bd;/);
  });

  it("places region actions at the map origin and reveals territory controls only for owned cells", () => {
    const mapCard = html.slice(html.indexOf('<div class="map-card">'), html.indexOf('<section id="selected-area"'));
    expect(mapCard).toContain('id="map-region-actions-shell"');
    expect(mapCard).toContain('id="map-region-actions"');
    expect(mapCard).toContain('id="map-region-actions-toggle"');
    expect(mapCard).toContain('aria-controls="map-region-actions"');
    expect(mapCard).toContain('id="territory-actions"');
    expect(mapCard).toContain('id="start-mining"');
    expect(mapCard).toContain('id="train-amount" type="range" min="0"');
    expect(mapCard).toContain('id="train-amount-value"');
    expect(mapCard).toContain('id="train-amount-max"');
    expect(mapCard).toContain('id="mining-cooldown" class="mining-cooldown"');
    expect(mapCard).toContain('class="train-cost">消耗 <b id="train-cost">0</b> 金币');
    expect(mapCard).toContain('id="train"');
    expect(mapCard).toContain("开采资源");
    expect(mapCard).not.toContain('id="train-max"');
    expect(html).not.toContain('class="panel orders-panel"');
    expect(css).toMatch(/\.map-corner-shell\s*\{[^}]*position:\s*absolute;\s*top:\s*0;/);
    expect(css).toMatch(/\.map-corner-shell-left\s*\{[^}]*left:\s*0;/);
    expect(css).toMatch(/\.map-region-actions\s*\{[^}]*width:\s*100%;/);
    expect(css).toMatch(/\.map-corner-shell\.is-collapsed \.map-region-actions\s*\{[^}]*clip-path:\s*inset\(0 100% 0 0\)/);
    expect(css).toMatch(/\.map-corner-toggle\s*\{[^}]*position:\s*absolute;[^}]*transition:\s*top/);
    expect(css).toMatch(/\.mining-cooldown\s*\{[^}]*height:\s*10px;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.train-cost\s*\{[^}]*height:\s*10px;[^}]*white-space:\s*nowrap/);
    expect(source).toContain('document.querySelector("#territory-actions").classList.toggle("hidden", !player || !mine)');
    expect(source).toContain('actionsShell.classList.toggle("hidden", !actionsVisible)');
    expect(source).toContain('setMapCornerCollapsed("region", !regionActionsCollapsed)');
    expect(source).toContain('document.querySelector("#train-cost").textContent = formatNumber(trainingGoldCost(value, cell, remaining))');
    expect(source).toContain('trainingGoldCost(trainAmount.value, cell, remainingGarrison) > Number(player?.gold || 0)');
  });

  it("reuses the territory transfer panel in the map top-right or march dialog", () => {
    const mapCard = html.slice(html.indexOf('<div class="map-card">'), html.indexOf('<section id="selected-area"'));
    const confirmation = html.slice(html.indexOf('<section id="march-confirmation"'), html.indexOf('<section id="zero-army-march-confirmation"'));
    expect(html).not.toContain('id="march-party-panel"');
    expect((html.match(/id="map-army-transfer"/g) || []).length).toBe(1);
    expect(mapCard).toContain('id="map-army-transfer-shell"');
    expect(mapCard).toContain('id="map-army-transfer"');
    expect(mapCard).toContain('id="map-army-transfer-toggle"');
    expect(mapCard).toContain('aria-controls="map-army-transfer"');
    expect(mapCard).toContain('id="army-transfer-amount"');
    expect(mapCard).toContain('data-army-delta="-50"');
    expect(mapCard).toContain('data-army-delta="-10"');
    expect(mapCard).toContain('data-army-delta="10"');
    expect(mapCard).toContain('data-army-delta="50"');
    expect(mapCard).toContain('id="army-transfer-gather-all"');
    expect(mapCard).toContain('id="army-transfer-deploy-max"');
    expect(mapCard).toContain('id="army-transfer-confirm"');
    expect(confirmation).toContain('id="march-army-transfer-slot"');
    expect(mapCard).not.toContain("data-army-action");
    expect(css).toMatch(/\.map-corner-shell-right\s*\{[^}]*right:\s*0;/);
    expect(css).toMatch(/\.map-army-transfer\s*\{[^}]*width:\s*100%;/);
    expect(css).toMatch(/\.map-corner-shell\.is-collapsed \.map-army-transfer\s*\{[^}]*clip-path:\s*inset\(0 0 0 100%\)/);
    expect(source).toContain('const cell = position ? dynamicCell(position.x, position.y) : null');
    expect(source).toContain('const visible = Boolean(position && cell?.ownerAccountId === ownAccountId() && !activeMarch)');
    expect(source).toContain('function placeArmyTransferPanel(inMarchModal)');
    expect(source).toContain('const inMarchModal = Boolean(visible && marchConfirmationTarget)');
    expect(source).toContain('placeArmyTransferPanel(inMarchModal)');
    expect(source).toContain('if (panel.parentElement !== slot) slot.append(panel)');
    expect(source).toContain('if (panel.parentElement !== shell) shell.prepend(panel)');
    expect(source).toContain('panel.classList.toggle("hidden", !visible)');
    expect(source).toContain('panel.setAttribute("aria-hidden", String(!visible || (!inMarchModal && armyTransferCollapsed)))');
    expect(source).toContain('setMapCornerCollapsed("army", !armyTransferCollapsed)');
    expect(source).toContain('const type = armyTransferDraft > 0 ? "gather-march" : "deploy-soldiers"');
    expect(source).toContain('sendIntent({ type, amount })');
    expect(source).toContain('{ clamp: false, write: false }');
    expect(source).toContain('return Math.max(0, Math.trunc(Number(ownPlayer()?.fieldArmySoldiers) || 0))');
    expect(source).not.toContain('document.querySelectorAll("[data-army-action]")');
    expect(source).not.toContain("marchDraftSoldiers");
  });

  it("keeps extra draggable space beyond every map edge", () => {
    expect(css).toMatch(/\.map-viewport\s*\{[\s\S]*?--map-edge-drag:\s*clamp\(84px, 10cqi, 136px\);[\s\S]*?padding:\s*var\(--map-edge-drag\)/);
    expect(css).toContain(".map-viewport { --map-edge-drag: 72px; }");
  });

  it("keeps player location and drag-volume controls in the persistent chrome", () => {
    expect(html).toContain('id="center-player"');
    expect(html.indexOf('id="center-player"')).toBeLessThan(html.indexOf('class="legend-tip"'));
    expect(html.slice(html.indexOf('id="center-player"'), html.indexOf('class="legend-tip"'))).not.toContain('class="neutral"');
    expect(html).toContain('id="sound-volume" class="visually-hidden" type="range" min="0" max="100"');
    expect(html).toMatch(/<button id="sound-knob"[^>]*role="slider"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"/);
    expect(html).not.toContain('id="sound-toggle"');
    expect(source).toContain('centerMap(player.position)');
    expect(source).toContain('localStorage.setItem("fyow:sound-volume"');
    expect(source).toContain("soundKnob.setPointerCapture(event.pointerId)");
    expect(source).toContain("function soundPercentFromPointer(clientX, clientY)");
    expect(source).toContain("Math.max(-135, Math.min(135, angle))");
    expect(source).toContain("current >= 100 ? 0 : Math.min(100, current + 10)");
    expect(source).toContain("function ensureAudioReady()");
    expect(source).toContain("context.resume?.()");
    expect(source).toContain('document.addEventListener("pointerdown", event => {');
    expect(source).toContain('button !== soundKnob) playSound("click")');
    expect(source).toContain('if (!volume || !context || context.state === "closed") return');
    expect(source).toContain("const volume = soundVolumeLevel");
    expect(source).toContain("revision !== pendingSoundRevision");
    expect(css).toMatch(/\.legend #center-player\s*\{/);
    expect(css).toMatch(/\.sound-control\s*\{[^}]*right:\s*7px;[^}]*top:\s*50%;[^}]*height:\s*26px/);
    expect(css).toMatch(/\.sound-knob\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*flex:\s*0 0 24px/);
    expect(css).toMatch(/\.time-strip \.sound-knob > i::before\s*\{/);
  });

  it("opens a confirmation dialog before dispatching a march", () => {
    const confirmation = html.slice(html.indexOf('<section id="march-confirmation"'), html.indexOf('<section id="zero-army-march-confirmation"'));
    const zeroArmyConfirmation = html.slice(html.indexOf('<section id="zero-army-march-confirmation"'), html.indexOf('<section id="general-action-modal"'));
    expect(confirmation).toContain('role="dialog"');
    expect(confirmation).toContain('id="march-confirmation-title">确认行军队伍');
    expect(confirmation).toContain('id="march-confirmation-generals"');
    expect(confirmation).toContain('id="march-party-duration"');
    expect(confirmation).toContain('<small>预计消耗</small><strong id="march-party-cost">');
    expect(confirmation).toContain('id="march-confirmation-submit"');
    expect(confirmation).toContain('id="march-quote-retry"');
    expect(confirmation).toContain('id="march-army-transfer-slot"');
    expect(source).toContain('renderMapArmyTransfer(player, false);');
    expect(zeroArmyConfirmation).toContain('id="zero-army-march-confirmation"');
    expect(zeroArmyConfirmation).toContain('您目前行军队伍中没有士兵，是否开始行军？');
    expect(zeroArmyConfirmation).toContain('id="zero-army-march-cancel"');
    expect(zeroArmyConfirmation).toContain('id="zero-army-march-confirm"');
    expect(source).toContain('document.querySelector("#march").addEventListener("click", () => {');
    expect(source).toContain("openMarchConfirmation()");
    expect(source).toContain('document.querySelector("#march-confirmation-submit").addEventListener("click", () => {');
    expect(source).toContain('if (marchAvailable() < 1) {');
    expect(source).toContain('document.querySelector("#zero-army-march-confirmation").classList.remove("hidden")');
    expect(source).toContain('document.querySelector("#zero-army-march-confirm").addEventListener("click", dispatchMarch)');
    expect(source).toContain('const requestId = sendIntent({ type: "march", ...selectedMarchIntent(target), expectedQuote })');
    expect(source).toContain('revision: marchQuoteCache.revision');
    expect(source).toContain('requestKey: marchQuoteCache.requestKey');
    expect(source).toContain('event.data.errorCode === "FYOW_MARCH_QUOTE_CHANGED"');
    expect(source).toContain('requestState?.key?.startsWith("intent:quote-march:")');
    expect(source).toContain('submit.disabled = marchSubmitting || transferPending');
    expect(source).toContain('if (marchSubmitting && !force) return false;');
    expect(source).toContain('activeJob && !marchSubmitting');
    expect(source).toContain('closeMarchConfirmation({ force: true })');
    expect(source).toContain('panel.inert = !visible || marchSubmitting');
    expect(source).toContain('note.textContent = "正在处理行军，请勿重复操作。"');
    expect(css).toMatch(/\.area-facts \.power-crest b\s*\{[^}]*font-size:\s*21px;[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.area-facts \.power-crest\s*\{[^}]*grid-column:\s*1 \/ -1/);
  });

  it("uses the same medicine names as the rules proxy", () => {
    for (const label of ["养气丹", "聚灵丹", "凝元丹", "紫府丹", "金髓丹", "赤曜丹"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain('"red-ascend": "升格效果"');
    expect(source).toContain('"red-reroll": "洗髓效果"');
    expect(source).toContain('"red-ascend": "#df6553", "red-reroll": "#df6553"');
  });

  it("keeps carried generals in the bottom-right with delayed expansion and drag ordering", () => {
    const area = html.slice(html.indexOf('<section id="selected-area"'), html.indexOf("</section>\n        </div>\n        <aside>"));
    expect(area.indexOf('class="area-owner"')).toBeLessThan(area.indexOf('class="area-companions"'));
    expect(area).toContain("随行将领");
    expect(html).not.toContain('id="march-generals"');
    expect(source).toContain("setTimeout(() => setCompanionsExpanded(true), 750)");
    expect(source).toContain('type: "reorder-carried-generals"');
    expect(source).toContain('node.draggable = true');
    expect(source).toContain('document.addEventListener("pointerdown"');
    expect(css).toMatch(/\.area-companions\.companions-expanded #carried-generals\s*\{[^}]*max-height:[^;]+;\s*overflow-y:\s*auto/);
    expect(css).toMatch(/\.area-companions\.sorting \.general-card:nth-child\(-n\+2\)\s*\{[^}]*border-style:\s*dashed;[^}]*#d22d88/);
  });

  it("requires an explicit decision before a discovered general is generated", () => {
    expect(html).toContain('id="general-discovery-confirmation"');
    expect(html).toContain('id="general-discovery-confirm"');
    expect(html).toContain('id="general-discovery-decline"');
    expect(source).toContain('type: "confirm-general-discovery"');
    expect(source).toContain('type: "decline-general-discovery"');
    expect(source).toContain("正在生成…");
  });

  it("uses one gold cultivation flow and hides materials for the player target", () => {
    expect(html).toContain("闭关修炼");
    expect(html).not.toContain('id="training-levels"');
    expect(source).toContain('document.querySelector("#cultivation-material-field").classList.toggle("hidden", !isGeneral)');
    expect(source).toContain('sendIntent({ type: "cultivate-player"');
    expect(source).not.toContain('玩家闭关不使用天材地宝');
    expect(source).toContain('generalExperienceLabel({ ...target.entity');
  });

  it("animates the left sidebar and bottom region bar while honoring reduced motion", () => {
    expect(css).toMatch(/\.layout\s*\{[\s\S]*?transition:\s*grid-template-columns/);
    expect(css).toMatch(/\.social-collapsed \.social-sidebar\s*\{[\s\S]*?transform:\s*translateX/);
    expect(css).toMatch(/\.map-workspace\s*\{[\s\S]*?transition:\s*grid-template-rows/);
    expect(css).toMatch(/\.area-collapsed \.area-content\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?transform:\s*translateY/);
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*?\.layout[\s\S]*?transition:\s*none/);
  });

  it("previews the same stepwise shortest route and real-time duration as the game rules", () => {
    const { ctx } = harness();
    const route = ctx.mapTaskOverlays[0];
    expect(route).toMatchObject({ type: "march", preview: true, durationMs: 90000, cost: 66 });
    expect(route.points).toEqual([
      { x: 4.5, y: 7.5 }, { x: 5.5, y: 7.5 }, { x: 6.5, y: 7.5 },
      { x: 7.5, y: 7.5 }, { x: 8.5, y: 7.5 }, { x: 8.5, y: 8.5 }, { x: 8.5, y: 9.5 }
    ]);
    expect(ctx.marchMapRoute({ x: 0, y: 0 }, { x: 63, y: 63 }).durationMs).toBe(126 * 15000);
    expect(ctx.marchMapRoute({ x: 4, y: 7 }, { x: 4, y: 7 })).toBeNull();
    for (const bad of [{ x: -1, y: 7 }, { x: 64, y: 7 }, { x: 1.5, y: 7 }, { x: NaN, y: 7 }, null]) {
      expect(ctx.marchMapRoute(bad, { x: 1, y: 1 })).toBeNull();
    }
    expect(ctx.mapTaskDescription(route)).toContain("预计耗时：90秒");
  });

  it("prefers discounted owned roads and automatically routes to a reachable enemy target", () => {
    const { ctx } = harness();
    const cells: Record<string, any> = {
      "4,7": { ownerAccountId: "self", soldiers: 0, generalIds: [] },
      "4,8": { ownerAccountId: "self", soldiers: 0, generalIds: [] },
      "5,8": { ownerAccountId: "self", soldiers: 0, generalIds: [] },
      "6,8": { ownerAccountId: "self", soldiers: 0, generalIds: [] }
    };
    ctx.dynamicCell = (x: number, y: number) => cells[`${x},${y}`] || { ownerAccountId: null, soldiers: 0, generalIds: [] };
    const target = { x: 6, y: 7 };
    const economic = ctx.marchMapRoute({ x: 4, y: 7 }, target);
    expect(economic.path).toEqual([{ x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 }, target]);
    expect(economic).toMatchObject({ ownDistance: 3, ordinaryDistance: 1, weightQuarters: 7, durationMs: 26_250 });

    cells["6,7"] = { ownerAccountId: "enemy", soldiers: 1, generalIds: [] };
    ctx.selected = target;
    expect(ctx.selectedMarchIntent().attack).toBe(true);
    expect(ctx.marchMapRoute({ x: 4, y: 7 }, target, { attack: true })?.path.at(-1)).toEqual(target);

    for (const point of [{ x: 5, y: 7 }, { x: 7, y: 7 }, { x: 6, y: 6 }, { x: 6, y: 8 }]) {
      cells[`${point.x},${point.y}`] = { ownerAccountId: "enemy", soldiers: 1, generalIds: [] };
    }
    expect(ctx.marchMapRoute({ x: 4, y: 7 }, target, { attack: true })).toBeNull();
    expect(source).toContain('inaccessible ? "无法抵达"');
  });

  it("isolates map-preview routes from an open confirmation target and rejects mismatched cached paths", () => {
    const { ctx } = harness();
    const modalTarget = { x: 6, y: 7 };
    const selectedTarget = { x: 8, y: 9 };
    ctx.marchConfirmationTarget = modalTarget;
    ctx.selected = selectedTarget;
    ctx.marchQuoteCache = {
      requestKey: ctx.marchQuoteKey(modalTarget),
      path: [{ x: 5, y: 7 }, modalTarget],
      cost: 2,
      durationMs: 30_000
    };

    const preview = ctx.buildMapTaskOverlays().find((item: any) => item.type === "march");
    expect(preview.to).toEqual(selectedTarget);
    expect(preview.path.at(-1)).toEqual(selectedTarget);
    expect(preview.distance).toBe(6);

    const recovered = ctx.marchMapRoute({ x: 4, y: 7 }, selectedTarget, {
      path: [{ x: 5, y: 7 }, modalTarget]
    });
    expect(recovered.path.at(-1)).toEqual(selectedTarget);
    expect(recovered.distance).toBe(6);
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

  it("adds a right-sidebar market count and waterfall marketplace dialog", () => {
    expect(html).toContain('id="market-open"');
    expect(html).toContain('id="market-count"');
    expect(html).toContain("在售数量");
    expect(html).toContain('id="market-listings"');
    expect(html).toContain('id="market-sell-open"');
    expect(html).toContain('id="market-sell-form"');
    expect(html).toContain('id="market-sell-general"');
    expect(html).toContain('id="market-sell-note"');
    expect(html).toContain('id="market-manage-sheet"');
    expect(css).toMatch(/\.market-listings\s*\{[\s\S]*?columns:/);
    expect(css).toMatch(/\.market-entry strong\s*\{[\s\S]*?display:\s*grid/);
    expect(css).toMatch(/\.market-listing\.market-owned/);
    expect(source).toContain('type: "list-general"');
    expect(source).toContain('type: "buy-market-general"');
    expect(source).toContain('sellerIntro');
    expect(source).toContain('openMarketManage');
    expect(source).toContain('confirmMarketDelist');
    expect(source).toContain('marketCooldownUntil');
    expect(source).not.toContain('function listGeneralForSale');
    expect(source).not.toContain('buttons.append(makeButton("上架"');
    expect(source).toContain('renderMarket()');
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
    expect(ctx.mapTaskDescription(mine, 1000)).toContain("本轮剩余：600秒");
    expect(ctx.mapTaskDescription(mine, 2000)).toContain("本轮剩余：599秒");
    expect(ctx.mapTaskDescription(mine, 601000)).toContain("本轮剩余：等待结算");
    expect(ctx.mapTaskDescription(mine)).toContain("本轮预计获得：35 金币");
    mine.job.lastSettledAt = 61000;
    expect(ctx.mapTaskDescription(mine, 90000)).toContain("本轮剩余：511秒");
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
    expect(tooltip.textContent).toContain("本轮剩余：600秒");
    ctx.hostTime = () => 2000;
    ctx.renderMapTaskTooltip();
    expect(tooltip.textContent).toContain("本轮剩余：599秒");
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

  it("omits estimated gold from route previews but shows paid gold for an active march", () => {
    const { ctx, tooltip, jobs } = harness();
    ctx.mapPointer = { x: 174, y: 129 };
    ctx.renderMapTaskTooltip();
    expect(tooltip.textContent).toContain("预计耗时：90秒");
    expect(tooltip.textContent).not.toContain("预计消耗");
    expect(tooltip.children).toHaveLength(0);

    jobs.army = { id: "army", type: "march", accountId: "self", from: { x: 2, y: 3 }, to: { x: 9, y: 3 }, finishAt: 121000, soldiers: 80, generalIds: ["g"], cost: 42 };
    ctx.mapTaskOverlays = ctx.buildMapTaskOverlays();
    ctx.mapPointer = { x: 164, y: 89 };
    ctx.renderMapTaskTooltip();
    expect(tooltip.children.at(-1)).toMatchObject({ className: "route-cost", textContent: "已支付：42 金币" });
  });
});
