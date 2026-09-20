import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/game.js", import.meta.url), "utf8");
const dialogueFunctions = source.slice(source.indexOf("function renderDialogue()"), source.indexOf("function openDialogue("));
const dialogueSubmit = source.slice(
  source.indexOf("function sendDialogue()"),
  source.indexOf('document.querySelectorAll(".overlay")')
);

function createHarness() {
  let available = true;
  const history: any = { children: [], replaceChildren() { this.children = []; }, append(...nodes: any[]) { this.children.push(...nodes); }, scrollTop: 0, scrollHeight: 0 };
  const input: any = { value: "", disabled: false, placeholder: "", listeners: {}, addEventListener(type: string, listener: (event: any) => void) { this.listeners[type] = listener; } };
  const button: any = { click: null, setAttribute() {}, addEventListener(_type: string, listener: () => void) { this.click = listener; } };
  const labels: Record<string, any> = { "#dialogue-history": history, "#dialogue-input": input, "#dialogue-send": button, "#dialogue-general": {}, "#dialogue-mode": {} };
  const general: any = { name: "赤岚·霜牙", status: "carried", interactionHistory: [] };
  const requests = new Map<string, any>();
  const context: any = {
    document: { querySelector: (selector: string) => labels[selector], createElement: () => ({ className: "", textContent: "" }) },
    dialogueGeneralId: "general-1",
    dialogueRequests: requests,
    allGenerals: () => ({ "general-1": general }),
    ownPlayer: () => ({ displayName: "茂密" }),
    ownAccountId: () => "player-1",
    accountLabel: () => "茂密",
    canInteract: () => available,
    redactAccountIds: (value: string) => value,
    sendIntent: () => "request-1"
  };
  runInNewContext(`${dialogueFunctions}\n${dialogueSubmit}`, context);
  return { context, general, requests, input, history, button, setAvailable(value: boolean) { available = value; } };
}

describe("grid world general chat UI", () => {
  it("shows the outgoing text while waiting, retains it on failure, and replaces it with the saved reply", () => {
    const ui = createHarness();
    ui.input.value = "谈谈北境战事";
    ui.button.click();
    expect(ui.input.value).toBe("");
    expect(ui.history.children.map((node: any) => node.textContent)).toEqual(["谈谈北境战事", "正在等待将领回复……"]);

    ui.context.failDialogueRequest("request-1", "同步暂时中断");
    expect(ui.input.value).toBe("谈谈北境战事");
    expect(ui.history.children.map((node: any) => node.textContent)).toEqual(["谈谈北境战事", "发送失败：同步暂时中断"]);

    ui.input.value = "谈谈北境战事";
    ui.button.click();
    expect(ui.requests.size).toBe(1);
    ui.general.interactionHistory.push({ accountId: "player-1", userText: "谈谈北境战事", reply: "北境正待用兵。", narration: "她垂眸整理袖口，随后抬眼望向你。" });
    ui.context.finishDialogueResult("request-1", { dialogue: { reply: "北境正待用兵。" } });
    ui.context.renderDialogue();
    expect(ui.history.children.map((node: any) => node.textContent)).toEqual(["谈谈北境战事", "北境正待用兵。", "她垂眸整理袖口，随后抬眼望向你。"]);
  });

  it("keeps the draft when another dialogue request is already pending", () => {
    const ui = createHarness();
    ui.context.sendIntent = () => null;
    ui.input.value = "请回答我";
    ui.button.click();
    expect(ui.input.value).toBe("请回答我");
    expect(ui.requests.size).toBe(0);
  });

  it("keeps deployed dialogue history visible while disabling messages from another cell", () => {
    const ui = createHarness();
    ui.general.status = "deployed";
    ui.general.location = { x: 8, y: 9 };
    ui.general.interactionHistory.push({ accountId: "player-1", userText: "守备如何？", reply: "一切安稳。" });
    ui.setAvailable(false);
    ui.context.renderDialogue();
    expect(ui.history.children.map((node: any) => node.textContent)).toEqual(["守备如何？", "一切安稳。"]);
    expect(ui.input.disabled).toBe(true);
    expect(ui.input.placeholder).toContain("抵达将领所在区域");
    expect(ui.button.disabled).toBe(true);
  });
});
