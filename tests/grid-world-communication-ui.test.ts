import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/game.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/styles.css", import.meta.url), "utf8");

function node(text = "") {
  const value: any = {
    textContent: text, value: "", children: [], listeners: {}, className: "", hidden: false, inert: false,
    append(...items: any[]) { this.children.push(...items); this.textContent = this.children.map((child: any) => child?.textContent || "").join(""); },
    appendChild(item: any) { this.append(item); },
    replaceChildren(...items: any[]) { this.children = [...items]; this.textContent = this.children.map((child: any) => child?.textContent || "").join(""); },
    addEventListener(type: string, listener: (...args: any[]) => void) { this.listeners[type] = listener; },
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return null; }
  };
  return value;
}

describe("grid world communication UI", () => {
  it("renders a complete local date and time for world chat timestamps", () => {
    const context: any = {};
    const functions = source.slice(source.indexOf("function worldChatTimestamp"), source.indexOf("function renderWorldChat"));
    runInNewContext(functions, context);
    const timestamp = new Date(2026, 8, 25, 7, 8, 9).getTime();
    expect(context.worldChatTime({ createdAt: timestamp })).toBe("2026-09-25 07:08:09");
    expect(context.worldChatTime({ createdAt: Math.floor(timestamp / 1000) })).toBe("2026-09-25 07:08:09");
    expect(context.worldChatTime({ createdAt: new Date(timestamp).toISOString() })).toBe("2026-09-25 07:08:09");
    expect(context.worldChatTime({ createdAt: 0 })).toBe("刚刚");
    expect(css).toMatch(/\.chat-message time\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.chat-message time\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(source).toContain("time.title = `本地时间：${time.textContent}");
  });

  it("provides unread indicators and separate received/sent letter panes", () => {
    expect(html).toContain('id="social-unread-badge"');
    expect(html).toContain('data-social-badge="world"');
    expect(html).toContain('data-social-badge="generals"');
    expect(html).toContain('data-social-badge="letters"');
    expect(html).toContain('id="direct-inbox"');
    expect(html).toContain('id="direct-outbox"');
    expect(html).toContain('id="letter-detail-modal"');
    expect(html).toContain('id="letter-detail-text"');
    expect(css).toMatch(/\.letters-columns\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.letters-column \.direct-inbox\s*\{[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.letters-column \.direct-inbox\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(css).toMatch(/\.direct-message\.letter-summary/);
    expect(css).toMatch(/\.letter-detail-text/);
    expect(css).toContain(".social-tab-badge.hidden, .social-unread-badge.hidden");
    expect(source).toContain("updateCommunicationNotifications(next, background && !pendingHostRequests.size)");
    expect(source).toContain('playSound(soundKind)');
    expect(source).toContain("function openLetterDetail");
    expect(source).toContain("function renderLetterColumn");
    expect(source).toContain('markCommunicationRead(tab)');
  });

  it("increments unread badges and plays a category sound only after the initial baseline", () => {
    const badges: Record<string, any> = {
      "#social-unread-badge": node(),
      '[data-social-badge="world"]': node(),
      '[data-social-badge="generals"]': node(),
      '[data-social-badge="letters"]': node(),
      "#direct-unread": node()
    };
    const sounds: string[] = [];
    const context: any = {
      communicationUnread: { world: 0, generals: 0, letters: 0 },
      communicationSeen: { world: new Set(), generals: new Set(), letters: new Set() },
      communicationNotificationsInitialized: false,
      socialTab: "world",
      document: { querySelector: (selector: string) => badges[selector] || null },
      playSound: (kind: string) => sounds.push(kind),
    };
    const functions = source.slice(source.indexOf("function communicationItemId"), source.indexOf("function ownerColor"));
    runInNewContext(functions, context);
    const base = {
      account: { accountId: "self" }, worldChat: [{ messageId: "old-chat", accountId: "self", text: "我已抵达" }],
      directInbox: [{ messageId: "old-letter", fromAccountId: "other", payload: { text: "旧信" } }],
      world: { generals: { g: { id: "g", holderAccountId: "self", interactionHistory: [{ year: 1, reply: "旧答" }] } } }
    };
    context.updateCommunicationNotifications(base);
    expect(context.communicationUnread).toEqual({ world: 0, generals: 0, letters: 0 });
    expect(sounds).toEqual([]);
    context.updateCommunicationNotifications({
      ...base,
      worldChat: [...base.worldChat, { messageId: "new-chat", accountId: "other", text: "边境有变" }],
      directInbox: [...base.directInbox, { messageId: "new-letter", fromAccountId: "other", payload: { text: "新信" } }]
    });
    expect(context.communicationUnread.world).toBe(1);
    expect(context.communicationUnread.letters).toBe(1);
    expect(sounds).toEqual(["letter"]);
    expect(badges['[data-social-badge="world"]'].textContent).toBe("1");
    expect(badges['[data-social-badge="letters"]'].textContent).toBe("1");
    expect(badges["#social-unread-badge"].textContent).toBe("2");
  });

  it("renders compact received/sent summaries and opens the full letter modal", () => {
    const inbox = node();
    const outbox = node();
    const total = node();
    const receivedCount = node();
    const sentCount = node();
    const modal = node();
    modal.classList = { add() { modal.hidden = false; }, remove() { modal.hidden = false; }, toggle() {} };
    const detailKind = node();
    const detailTitle = node();
    const detailMeta = node();
    const detailPurpose = node();
    detailPurpose.classList = { add() {}, remove() {}, toggle() {} };
    const detailText = node();
    const labels: Record<string, any> = {
      "#direct-inbox": inbox, "#direct-outbox": outbox, "#direct-count": total,
      "#direct-received-count": receivedCount, "#direct-sent-count": sentCount,
      "#letter-detail-modal": modal, "#letter-detail-kind": detailKind, "#letter-detail-title": detailTitle,
      "#letter-detail-meta": detailMeta, "#letter-detail-purpose": detailPurpose, "#letter-detail-text": detailText
    };
    const context: any = {
      payload: {
        directHistory: [
          { messageId: "in-1", fromAccountId: "other", createdAt: 1000, payload: { generalName: "青禾", purpose: "报平安", text: "边境已经安稳。" } },
          { messageId: "out-1", direction: "out", toAccountId: "other", createdAt: 2000, payload: { generalName: "青禾", text: "请继续留意北境。" } }
        ]
      },
      document: { querySelector: (selector: string) => labels[selector] || null, createElement: (tag: string) => { const created = node(); created.tagName = tag; return created; } },
      accountLabel: (id: string) => id === "other" ? "北境玩家" : id,
      ownAccountId: () => "self",
      ownPlayer: () => ({ displayName: "本地测试" }),
      letterDetailItem: null
    };
    const functions = source.slice(source.indexOf("function mergeDirectMessages"), source.indexOf("function resizeGamePanels"));
    runInNewContext(functions, context);
    context.renderInbox();
    expect(total.textContent).toBe("2");
    expect(receivedCount.textContent).toBe("1");
    expect(sentCount.textContent).toBe("1");
    expect(inbox.children).toHaveLength(1);
    expect(outbox.children).toHaveLength(1);
    expect(inbox.children[0].textContent).toContain("青禾 给 self 的信件");
    expect(inbox.children[0].textContent).not.toContain("边境已经安稳。");
    expect(inbox.children[0].textContent).not.toContain("为了：报平安");
    expect(inbox.children[0].textContent).not.toContain("请继续留意北境。");
    inbox.children[0].listeners.click();
    expect(modal.classList).toBeDefined();
    expect(detailTitle.textContent).toBe("报平安");
    expect(detailText.textContent).toBe("边境已经安稳。");
    expect(detailPurpose.textContent).toBe("");
  });
});
