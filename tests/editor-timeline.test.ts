import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
const timelineStart = renderer.indexOf("const ONLINE_EDITOR_TIMELINE_TOOL_LABELS");
const timelineEnd = renderer.indexOf("async function loadOnlineWorldEditorProject", timelineStart);
const timelineSource = renderer.slice(timelineStart, timelineEnd);

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  dateTime = "";
  open = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  replaceCalls = 0;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set innerHTML(_value: string) {
    throw new Error("timeline rendering must not use innerHTML");
  }

  append(...items: FakeElement[]) {
    this.children.push(...items);
  }

  replaceChildren(...items: FakeElement[]) {
    this.replaceCalls++;
    this.children = items;
  }

  querySelectorAll(selector: string) {
    if (selector !== "details[data-online-editor-event-key]") return [];
    return descendants(this).filter(node => node.tagName === "details" && node.dataset.onlineEditorEventKey);
  }
}

function descendants(node: FakeElement): FakeElement[] {
  return [node, ...node.children.flatMap(descendants)];
}

function timelineFixture(savedEvents: any[] = []) {
  const mount = new FakeElement("mount");
  const document = {
    querySelector: (selector: string) => selector === "#online-editor-agent-result" ? mount : null,
    createElement: (tagName: string) => new FakeElement(tagName),
    createDocumentFragment: () => new FakeElement("fragment")
  };
  const context: any = {
    console,
    Date,
    document,
    selectedOnlineWorldEditorId: "draft",
    onlineWorldEditorProject: { harnessCandidate: { events: savedEvents } },
    formatRoomChatTime: (value: number) => String(value)
  };
  vm.runInNewContext(`${timelineSource}\nglobalThis.__timeline = { onlineEditorTimelineEvents, onlineEditorTimelineText, onlineEditorTimelineView, renderOnlineWorldEditorTimeline };`, context);
  return { context, mount, api: context.__timeline };
}

describe("online editor timeline renderer", () => {
  it("renders hostile summaries and evidence through textContent", () => {
    const hostileSummary = '<img src=x onerror="globalThis.injected=true"><script>bad()</script>';
    const hostileContent = '</pre><script>globalThis.injected=true</script>';
    const { api, mount } = timelineFixture();

    api.renderOnlineWorldEditorTimeline({
      libraryId: "draft",
      status: "running",
      events: [{
        turn: 1,
        kind: "tool-result",
        tool: "read_file",
        summary: hostileSummary,
        result: { path: "program.html", content: hostileContent, reasoning: "private model notes" }
      }]
    });

    const nodes = descendants(mount);
    expect(nodes.find(node => node.tagName === "p")?.textContent).toBe(hostileSummary);
    expect(nodes.find(node => node.tagName === "pre")?.textContent).toContain(hostileContent);
    expect(nodes.find(node => node.tagName === "pre")?.textContent).not.toContain("private model notes");
    expect(nodes.some(node => node.tagName === "script" || node.tagName === "img")).toBe(false);
    expect(timelineSource).toContain("summary.textContent=view.summary");
    expect(timelineSource).toContain("pre.textContent=view.detail");
    expect(timelineSource).not.toContain("summary.innerHTML");
    expect(timelineSource).not.toContain("pre.innerHTML");
  });

  it("replays matching live job events and falls back to saved candidate events", () => {
    const saved = [{ tool: "review", kind: "review", summary: "saved review" }];
    const live = [{ tool: "read_file", kind: "tool-result", summary: "live read" }];
    const { api, context, mount } = timelineFixture(saved);

    api.renderOnlineWorldEditorTimeline({ libraryId: "other", status: "completed", events: live });
    expect(descendants(mount).find(node => node.tagName === "p")?.textContent).toBe("saved review");

    api.renderOnlineWorldEditorTimeline({ libraryId: "draft", status: "running", events: live });
    expect(descendants(mount).find(node => node.tagName === "p")?.textContent).toBe("live read");
    expect(api.onlineEditorTimelineEvents({ libraryId: "draft", events: live }, { events: saved }, "draft").map((event: any) => event.summary)).toEqual(["live read"]);
    expect(api.onlineEditorTimelineEvents({ libraryId: "other", events: live }, { events: saved }, "draft").map((event: any) => event.summary)).toEqual(["saved review"]);
    expect(api.onlineEditorTimelineEvents({ libraryId: "draft", status: "failed", events: [] }, { events: saved }, "draft").map((event: any) => event.summary)).toEqual(["saved review"]);
    expect(api.onlineEditorTimelineEvents({ libraryId: "draft", status: "running", events: [] }, { events: saved }, "draft")).toEqual([]);

    api.renderOnlineWorldEditorTimeline({ libraryId: "draft", status: "failed", events: [] });
    expect(descendants(mount).find(node => node.tagName === "p")?.textContent).toBe("saved review");

    context.onlineWorldEditorProject = { harness: { events: [{ tool: "finish", summary: "completed saved run" }] } };
    api.renderOnlineWorldEditorTimeline(null);
    expect(descendants(mount).find(node => node.tagName === "p")?.textContent).toBe("completed saved run");
  });

  it("compacts raw saved mutation evidence and private fields before rendering", () => {
    const source = "SECRET-SOURCE-LINE\n".repeat(2000);
    const saved = [{
      tool: "patch_file",
      kind: "assistant-action",
      args: {
        path: "program.html",
        oldText: source,
        newText: `${source}changed`,
        analysis: "SECRET-REASONING",
        nested: { chainOfThought: "SECRET-NESTED-REASONING", label: "public label" }
      }
    }];
    const { api, mount } = timelineFixture(saved);

    api.renderOnlineWorldEditorTimeline(null);

    const detail = descendants(mount).find(node => node.tagName === "pre")?.textContent || "";
    expect(detail).toContain('"path": "program.html"');
    expect(detail).toContain('"characters": 38000');
    expect(detail).toContain('"label": "public label"');
    expect(detail).not.toContain("SECRET-SOURCE-LINE");
    expect(detail).not.toContain("SECRET-REASONING");
    expect(detail).not.toContain("SECRET-NESTED-REASONING");
  });

  it("keeps expanded evidence and skips DOM replacement when events are unchanged", () => {
    const event = {
      at: 123,
      turn: 2,
      kind: "tool-result",
      tool: "read_file",
      summary: "read complete",
      result: { path: "program.html", content: "visible evidence" }
    };
    const { api, mount } = timelineFixture();

    api.renderOnlineWorldEditorTimeline({ libraryId: "draft", status: "running", events: [event] });
    const details = descendants(mount).find(node => node.tagName === "details");
    expect(details).toBeTruthy();
    details!.open = true;
    const replaceCalls = mount.replaceCalls;

    api.renderOnlineWorldEditorTimeline({ libraryId: "draft", status: "running", events: [{ ...event, result: { ...event.result } }] });

    expect(mount.replaceCalls).toBe(replaceCalls);
    expect(descendants(mount).find(node => node.tagName === "details")).toBe(details);
    expect(details!.open).toBe(true);

    api.renderOnlineWorldEditorTimeline({
      libraryId: "draft",
      status: "running",
      events: [event, { at: 124, turn: 3, kind: "status", tool: "model", summary: "next turn" }]
    });

    expect(mount.replaceCalls).toBe(replaceCalls + 1);
    expect(descendants(mount).find(node => node.tagName === "details")?.open).toBe(true);
  });

  it("renders bounded previews and skips malformed legacy entries and dates", () => {
    const summary = `VISIBLE-${"x".repeat(30000)}-HIDDEN-TAIL`;
    const saved = [null, {
      tool: "read_file",
      kind: "tool-result",
      at: 1e20,
      summary,
      result: {
        values: Array.from({ length: 10000 }, (_, index) => index),
        Reasoning: "PRIVATE-RESULT",
        feedback: { answer: JSON.stringify({ summary: "public", thinking: "PRIVATE-ANSWER" }) }
      }
    }];
    const { api, mount } = timelineFixture(saved as any[]);

    expect(() => api.renderOnlineWorldEditorTimeline(null)).not.toThrow();
    const nodes = descendants(mount);
    const renderedSummary = nodes.find(node => node.tagName === "p")?.textContent || "";
    const detail = nodes.find(node => node.tagName === "pre")?.textContent || "";
    expect(renderedSummary.length + detail.length).toBeLessThanOrEqual(24000);
    expect(renderedSummary).toContain("VISIBLE-");
    expect(renderedSummary).toContain("记录已截断");
    expect(renderedSummary).not.toContain("HIDDEN-TAIL");
    expect(detail).not.toContain("PRIVATE-RESULT");
    expect(detail).not.toContain("PRIVATE-ANSWER");
    expect(nodes.some(node => node.tagName === "time")).toBe(false);
    expect(api.onlineEditorTimelineEvents(null, { events: saved }, "draft")).toHaveLength(1);
  });
});
