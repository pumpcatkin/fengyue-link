import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
const titleSource = source.slice(source.indexOf("function onlineWorldCardDisplayTitle("), source.indexOf("function selectedOnlineWorldProfile("));
const renderSource = source.slice(source.indexOf("function renderOnlineWorld(next)"), source.indexOf('document.querySelector("#online-world-unopened-back").addEventListener'));

function harness() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", value: 0, dataset: {},
      classes: new Set<string>(),
      classList: { toggle(name: string, on: boolean) {
        if (on) elements.get(id).classes.add(name);
        else elements.get(id).classes.delete(name);
      } },
      removeAttribute() {}
    });
    return elements.get(id);
  };
  const calls: string[] = [];
  const context: any = {
    onlineWorldInLibrary: false,
    onlineWorldState: null,
    selectedOnlineWorldCardId: null,
    onlineWorldCards: [],
    onlineWorldPage: element("page"),
    onlineWorldFrame: element("frame"),
    settingsToggle: element("settings"),
    document: { querySelector: element },
    loadOnlineWorldProgram: () => calls.push("load"),
    unloadOnlineWorldProgram: () => calls.push("unload"),
    renderOnlineWorldProfileChoices() {},
    postOnlineWorldState() {},
    followOnlineWorldMigration() {}
  };
  runInNewContext(titleSource + renderSource, context);
  return { context, element, calls };
}

describe("game library server identity and unopened state", () => {
  it("distinguishes identical game titles by companion work without changing IDs", () => {
    const { context } = harness();
    context.onlineWorldCards = [
      { title: "猎艳疆土", workName: "猎艳疆土[faeaacf38c3a4338]", libraryId: "main" },
      { title: "猎艳疆土", workName: "猎艳疆土·4服[26ac5c7eb50441f6]", libraryId: "four" }
    ];
    const cards = context.onlineWorldGalleryCards();
    expect(cards.map((card: any) => card.title)).toEqual(["猎艳疆土", "猎艳疆土·4服"]);
    expect(cards.map((card: any) => card.libraryId)).toEqual(["main", "four"]);
    expect(context.onlineWorldCardDisplayTitle({ title: "自定义游戏" })).toBe("自定义游戏");
    expect(context.onlineWorldCardDisplayTitle({ workName: "我的游戏[第二章]" })).toBe("我的游戏[第二章]");
    expect(context.onlineWorldCardDisplayTitle({ title: "猎艳疆土(1服)", workName: "猎艳疆土[faeaacf38c3a4338]" })).toBe("猎艳疆土(1服)");
    expect(context.onlineWorldCardDisplayTitle({ title: "猎艳疆土(4服)", workName: "猎艳疆土·4服[26ac5c7eb50441f6]" })).toBe("猎艳疆土(4服)");
  });

  it("opens the server named in the dialog even after gallery selection changes", () => {
    const { context, element } = harness();
    runInNewContext(source.slice(source.indexOf("function onlineWorldCardForOpen("), source.indexOf("function closeCardAuthorMenus(")), context);
    context.onlineWorldCards = [
      { title: "猎艳疆土(1服)", libraryId: "same-card::main" },
      { title: "猎艳疆土(4服)", libraryId: "same-card::four" }
    ];
    element("#online-world-open-form").dataset.libraryId = "same-card::main";
    context.selectedOnlineWorldCardId = "same-card::four";
    expect(context.onlineWorldCardForOpen().libraryId).toBe("same-card::main");
    context.onlineWorldCards.shift();
    expect(context.onlineWorldCardForOpen()).toBeUndefined();
  });

  it("shows an explicit unopened screen instead of a fake empty world", () => {
    const { context, element, calls } = harness();
    context.renderOnlineWorld({
      status: "needs-initialization", initialized: false, isServerOwner: true,
      card: { title: "游戏", workName: "游戏·4服" }
    });
    expect(calls).toEqual(["unload"]);
    expect(element("#online-world-unopened").classes.has("hidden")).toBe(false);
    expect(element("#online-world-unopened-title").textContent).toBe("游戏·4服");
    expect(element("#online-world-setup").classes.has("hidden")).toBe(true);
    expect(element("frame").classes.has("hidden")).toBe(true);
  });

  it("loads initialized games and removes the unopened screen", () => {
    const { context, element, calls } = harness();
    context.renderOnlineWorld({ status: "ready", initialized: true, isServerOwner: false });
    expect(calls).toEqual(["load"]);
    expect(element("#online-world-unopened").classes.has("hidden")).toBe(true);
    expect(element("frame").classes.has("hidden")).toBe(false);
  });

  it("does not label loading, migration, or a closed library as an unopened server", () => {
    for (const next of [
      { status: "opening", loadProgress: { active: true } },
      { status: "needs-initialization", migration: { workId: "target" } }
    ]) {
      const { context, element } = harness();
      context.renderOnlineWorld(next);
      expect(element("#online-world-unopened").classes.has("hidden")).toBe(true);
    }
    const { context, element } = harness();
    context.onlineWorldInLibrary = true;
    context.renderOnlineWorld({ status: "needs-initialization" });
    expect(element("#online-world-unopened").classes.has("hidden")).toBe(true);
    expect(element("#online-world-setup").classes.has("hidden")).toBe(false);
  });
});
