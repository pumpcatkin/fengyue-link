import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const split = require("../electron/perspective-split.cjs");
const pipeline = require("../electron/plugin-pipeline.cjs");
const settings = require("../electron/work-settings.cjs");
const retryModels = require("../electron/perspective-retry-model.cjs");
const autoModels = require("../electron/auto-model-router.cjs");
const runtimeUtils = require("../electron/runtime-utils.cjs");
const members = [{ id: "a", displayName: "小丽" }, { id: "b", displayName: "小花" }];
const segment = (id: string, kind: string, audience: string[], text: string) => ({ id, kind, audience, text });
function fixture() {
  return {
    protocol: split.PERSPECTIVE_SCHEMA,
    players: [{ player_key: "a", display_name: "小丽", body_segments: ["b0", "b1"] }, { player_key: "b", display_name: "小花", body_segments: ["b0", "b2"] }],
    segments: [segment("h", "other", ["*"], "天气：\n小道消息：\n正文："), segment("b0", "body", ["*"], "今天天气很好，"), segment("b1", "body", ["a"], "小丽吃苹果"), segment("sep", "separator", [], "、"), segment("b2", "body", ["b"], "小花玩游戏"), segment("s1", "other", ["a"], "\n小丽状态："), segment("s2", "other", ["b"], "\n小花状态：")]
  };
}
const sourceOf = (value: any) => value.segments.map((s: any) => s.text).join("");
const parse = (value: any, source = sourceOf(fixture())) => split.parsePerspectiveResponse(JSON.stringify(value), { output: source, members });

function backend(overrides = {}) {
  const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  const type = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
    ...split, ...pipeline, ...settings, ...runtimeUtils, ...autoModels, URL, Buffer, console, setTimeout, clearTimeout, AbortController, setInterval, clearInterval,
    crypto: require("node:crypto"), ...require("../electron/multiplayer-prompts.cjs"), ...retryModels,
    perspectiveRetryModelKey: retryModels.modelKey, ...overrides
  });
  return Object.create(type.prototype);
}

describe("perspective retry model preference", () => {
  const record = (provider: string, model: string, label = model) => ({ provider_name: provider, model_id: model, model_label: label });
  it("reserves Gemini Flash and DeepSeek V4 Flash for the two retries", () => {
    const plan = retryModels.buildPerspectiveRetryModelPlan(
      { data: { models: [record("other", "slow-model"), record("deepseek", "deepseek-v4-flash"), record("google", "gemini-2.5-flash"), record("google", "gemini-pro")] } },
      { data: { model: { provider: "original", name: "original-model", completion_params: { temperature: 0.2 } } } }
    );
    expect(plan.candidates.slice(0, 2).map((item: any) => item.model)).toEqual(["gemini-2.5-flash", "deepseek-v4-flash"]);
    expect(plan.candidates.slice(2).map((item: any) => item.model)).toEqual(["slow-model", "gemini-pro"]);
  });
  it("never proposes the model that already failed and falls back to another live model", () => {
    const plan = retryModels.buildPerspectiveRetryModelPlan(
      { models: [record("google", "gemini-2.5-flash"), record("backup", "ordinary-model")] },
      { model: { provider: "google", name: "gemini-2.5-flash" } }
    );
    expect(plan.candidates.map((item: any) => item.model)).toEqual(["ordinary-model"]);
  });
  it("writes only the retry work model and verifies platform readback", async () => {
    const instance = backend();
    instance.appendSessionLog = vi.fn();
    instance.normalizeModelPayload = (value: any) => value.data || value;
    const target = { provider: "google", model: "gemini-flash", key: "google\0gemini-flash" };
    instance.platformGoApi = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ data: { model: { provider: "google", name: "gemini-flash" } } });
    await instance.applyPerspectiveRetryModel(target, { provider: "old", name: "old", completion_params: { temperature: 0.2 } }, 2);
    expect(instance.platformGoApi.mock.calls[0]).toEqual(["/apps/config", {
      method: "POST", timeout: 15000,
      body: { app_id: split.PERSPECTIVE_APP_ID, model: { provider: "google", name: "gemini-flash", completion_params: { temperature: 0.2 } } }
    }]);
    expect(instance.appendSessionLog).toHaveBeenCalledWith("perspective-retry", expect.objectContaining({ event: "model-saved", attempt: 2 }));
  });
});

describe("perspective partition and reconstruction", () => {
  it("reproduces the user's example exactly, including separate status lines", () => {
    const result = parse(fixture());
    expect(result.outputs.a).toBe("天气：\n小道消息：\n正文：今天天气很好，小丽吃苹果\n小丽状态：");
    expect(result.outputs.b).toBe("天气：\n小道消息：\n正文：今天天气很好，小花玩游戏\n小花状态：");
  });
  it("preserves shared HTML containers, entities, attributes and code fences without serialization", () => {
    const value = fixture();
    value.segments = [segment("h", "other", ["*"], '<section class="frame" data-x="a > b">\r\n```html\n'), segment("b0", "body", ["*"], "&amp; 😀 "), segment("b1", "body", ["a"], '<p id="a">小丽</p>'), segment("b2", "body", ["b"], '<p id="b">小花</p>'), segment("end", "other", ["*"], '\n```\r\n</section>')];
    const result = parse(value, sourceOf(value));
    expect(result.outputs.a).toBe('<section class="frame" data-x="a > b">\r\n```html\n&amp; 😀 <p id="a">小丽</p>\n```\r\n</section>');
  });
  it.each(["missing-player", "duplicate-player", "unknown-player", "renamed", "body", "duplicate-id", "audience", "extra", "discard-content"])("rejects %s", type => {
    const value: any = fixture();
    if (type === "missing-player") value.players.pop();
    if (type === "duplicate-player") value.players[1] = value.players[0];
    if (type === "unknown-player") value.players[1].player_key = "c";
    if (type === "renamed") value.players[1].display_name = "被改名";
    if (type === "body") value.players[1].body_segments = ["b2"];
    if (type === "duplicate-id") value.segments[1].id = "h";
    if (type === "audience") value.segments[1].audience = ["*", "a"];
    if (type === "extra") value.extra = "ignore";
    if (type === "discard-content") { value.segments[1].kind = "separator"; value.segments[1].audience = []; }
    expect(() => parse(value)).toThrow();
  });
  it.each(["whitespace", "line-endings", "wording"])("accepts %s differences without comparing the original text", type => {
    const value = fixture();
    const original = sourceOf(value);
    if (type === "whitespace") value.segments[1]!.text += "  ";
    if (type === "line-endings") value.segments[0]!.text = value.segments[0]!.text.replaceAll("\n", "\r\n");
    if (type === "wording") value.segments[1]!.text = "今天晴朗，";
    expect(sourceOf(value)).not.toBe(original);
    const { outputs } = parse(value, original);
    expect(outputs.a).toContain(value.segments[1]!.text);
    expect(outputs.a).toContain("小丽吃苹果");
    expect(outputs.a).not.toContain("小花玩游戏");
    expect(outputs.b).not.toContain("小丽吃苹果");
  });
  it("checks HTML offsets in the returned segments after formatting changes", () => {
    const value = fixture();
    value.segments.unshift(segment("open", "other", ["*"], '<section class="frame">'));
    value.segments.push(segment("close", "other", ["*"], "</section>"));
    const original = "\r\n   " + sourceOf(value).replaceAll("\n", "\r\n");
    const { outputs } = parse(value, original);
    expect(outputs.a).toBe('<section class="frame">天气：\n小道消息：\n正文：今天天气很好，小丽吃苹果\n小丽状态：</section>');
  });
  it("still rejects split HTML tags and broken projections when the original text differs", () => {
    const value = fixture();
    value.segments.unshift(segment("open", "other", ["a"], "<div>"));
    value.segments.push(segment("close", "other", ["*"], "</div>"));
    expect(() => parse(value)).toThrow("重组后 HTML 标签不完整");
    value.segments.splice(0, 1, segment("open1", "other", ["*"], '<div title="'), segment("open2", "other", ["a"], 'private">'));
    expect(() => parse(value)).toThrow("片段切断了 HTML 标签");
  });
  it("still rejects broken code fence projections when the original text differs", () => {
    const value = fixture();
    value.segments.unshift(segment("open", "other", ["a"], "```text\n"));
    value.segments.push(segment("close", "other", ["*"], "\n```"));
    expect(() => parse(value)).toThrow("重组后代码围栏不完整");
  });
  it("rejects structural damage even when concatenation still equals the original", () => {
    const value = fixture();
    value.segments.unshift(segment("open", "other", ["a"], "<div>"));
    value.segments.push(segment("close", "other", ["*"], "</div>"));
    expect(() => parse(value, sourceOf(value))).toThrow("HTML");
  });
  it("rejects a cut through an HTML attribute", () => {
    const value = fixture();
    value.segments.unshift(segment("open1", "other", ["*"], '<div title="'), segment("open2", "other", ["a"], 'private">'));
    value.segments.push(segment("close", "other", ["*"], "</div>"));
    expect(() => parse(value, sourceOf(value))).toThrow("HTML");
  });
  it("rejects an unmatched Markdown code fence after projection", () => {
    const value = fixture();
    value.segments.unshift(segment("fence-open", "other", ["a"], "```text\n"));
    value.segments.push(segment("fence-close", "other", ["*"], "\n```"));
    expect(() => parse(value, sourceOf(value))).toThrow("围栏");
  });
  it("accepts a sole fenced JSON but rejects commentary and partial JSON", () => {
    expect(split.parsePerspectiveResponse("```json\n" + JSON.stringify(fixture()) + "\n```", { output: sourceOf(fixture()), members }).outputs.a).toContain("小丽");
    expect(() => split.parsePerspectiveResponse("说明" + JSON.stringify(fixture()), { output: sourceOf(fixture()), members })).toThrow();
  });
  it("uses dynamic fences and one complete roster", () => {
    const request = split.buildPerspectiveRequest("`````html\n<div>source</div>\n`````", members);
    expect(request).toContain("``````text");
    expect(request).toContain('"player_key": "b"');
    expect(request).toContain("data_only");
  });
  it("never changes unmanaged prompt bytes, even after repeated updates and removal", () => {
    const original = "自定义\r\n\r\n\r\n尾部  \n";
    const enabled = split.upsertPerspectivePrefix(original, true, { wordsPerPlayer: 1200 });
    expect(enabled).toContain("1200 字");
    expect(split.upsertPerspectivePrefix(enabled, true, { wordsPerPlayer: 1200 })).toBe(enabled);
    const withSuffix = enabled + "\n\n用户追加\r\n ";
    const updated = split.upsertPerspectivePrefix(withSuffix, true, { wordsPerPlayer: 1600 });
    expect(split.upsertPerspectivePrefix(updated, false)).toBe(original + "\n\n用户追加\r\n ");
    expect(updated).not.toContain("1200 字");
  });
  it("defaults off without disabling a previously enabled effect plugin", () => {
    expect(pipeline.normalizePluginSettings().plugins[split.PERSPECTIVE_PLUGIN_ID].enabled).toBe(false);
    expect(pipeline.normalizePluginSettings({ version: 2, plugins: { "effect-judge": { enabled: true }, "perspective-split": { enabled: true, settings: { wordsPerPlayer: 1500 } } } }).plugins["effect-judge"].enabled).toBe(true);
    expect(split.normalizePerspectiveSettings({ wordsPerPlayer: 99999 }).wordsPerPlayer).toBe(10000);
  });
  it("disables only the managed session prefix and preserves all other configuration", async () => {
    const instance = backend({ fs: { readFileSync: () => "[]", writeFileSync: vi.fn() } });
    const original = "原始前置\r\n\r\n ";
    let stored = { pre_prompt: "原始主提示词", pre_text: split.upsertPerspectivePrefix(original, true) + "后续追加", post_text: "后置词", world_book: [{ key: "secret" }] };
    instance.currentWorkAppId = () => "work";
    instance.conversation = { activeId: "session" };
    instance.perspectiveTargetsPath = () => "unused";
    instance.appendSessionLog = vi.fn();
    instance.workGameUrl = () => null;
    instance.readPlatformConversationConfig = async () => ({ ...stored });
    instance.platformGoApi = vi.fn(async (_url, { body }) => { stored = { ...stored, ...body }; });
    await instance.syncPerspectivePrefix({ enabled: false, settings: {} });
    expect(instance.platformGoApi.mock.calls[0][1].body).toEqual({ app_id: "work", conversation_id: "session", is_global: false, pre_text: original + "后续追加" });
    expect(stored.pre_prompt).toBe("原始主提示词");
    expect(stored.post_text).toBe("后置词");
    expect(stored.world_book).toEqual([{ key: "secret" }]);
  });
  it("re-enables on a blank lobby session by creating and verifying its own config", async () => {
    let targets = JSON.stringify([{ appId: "work", conversationId: "old-session" }]);
    const original = "原前置词\r\n\r\n ";
    const records: Record<string, any> = {
      "old-session": { pre_text: split.upsertPerspectivePrefix(original, true), pre_prompt: "作品规则", post_text: "后置", is_global: false },
      "new-session": { pre_text: original, pre_prompt: "作品规则", post_text: "后置", is_global: true }
    };
    const saveSettings = vi.fn();
    const instance = backend({ fs: { readFileSync: () => targets, writeFileSync: (_: string, value: string) => { targets = value; } }, writePluginSettings: saveSettings });
    instance.currentWorkAppId = () => "work";
    instance.conversation = { activeId: null };
    instance.workSettings = {};
    instance.assertToolLoggedIn = () => {};
    instance.emit = vi.fn();
    instance.state = () => ({ plugins: instance.pluginSettings });
    instance.pluginSettings = pipeline.normalizePluginSettings({ plugins: { "perspective-split": { enabled: true } } });
    instance.perspectiveTargetsPath = () => "unused";
    instance.workGameUrl = () => null;
    instance.appendSessionLog = vi.fn();
    instance.readPlatformConversationConfig = async (_: string, id: string) => ({ ...records[id] });
    instance.platformGoApi = vi.fn(async (_: string, { body }: any) => { records[body.conversation_id] = { ...records[body.conversation_id], ...body }; });
    instance.ensureHostConversationForPromptConfig = vi.fn(async () => {
      expect(instance.pluginSettingsBusy).toBe(true);
      expect(instance.conversationBusy).toBe(true);
      instance.conversation.activeId = "new-session";
      return { conversationId: "new-session", created: true, marker: "bootstrap" };
    });
    instance.removeHostPromptBootstrapTurn = vi.fn(async () => {
      expect(records["new-session"].pre_text).toContain(split.PERSPECTIVE_BEGIN);
    });
    await instance.updatePluginSettings("perspective-split", { enabled: false });
    expect(records["old-session"].pre_text).toBe(original);
    expect(JSON.parse(targets)).toEqual([]);
    const result = await instance.updatePluginSettings("perspective-split", { enabled: true });
    expect(instance.ensureHostConversationForPromptConfig).toHaveBeenCalledWith({ allowLobby: true });
    expect(instance.removeHostPromptBootstrapTurn).toHaveBeenCalledWith("work", "new-session", "bootstrap");
    expect(result.prefixSync).toEqual({ status: "saved", conversationId: "new-session" });
    expect(records["new-session"].is_global).toBe(false);
    expect(records["new-session"].pre_prompt).toBe("作品规则");
    expect(records["old-session"].pre_text).toBe(original);
    await instance.updatePluginSettings("perspective-split", { enabled: false });
    await instance.updatePluginSettings("perspective-split", { enabled: true });
    expect(instance.ensureHostConversationForPromptConfig).toHaveBeenCalledTimes(1);
    expect(records["new-session"].pre_text.match(/FYMP_TWO_PART_NARRATIVE:BEGIN/g)).toHaveLength(1);
    expect(saveSettings).toHaveBeenCalledTimes(4);
    expect(instance.conversationBusy).toBe(false);
  });
  it("does not report enabled if the session prefix fails read-back, and releases locks", async () => {
    const saveSettings = vi.fn();
    const instance = backend({ fs: { readFileSync: () => "[]", writeFileSync: vi.fn() }, writePluginSettings: saveSettings });
    instance.currentWorkAppId = () => "work";
    instance.conversation = { activeId: null };
    instance.workSettings = {};
    instance.assertToolLoggedIn = () => {};
    instance.emit = vi.fn();
    instance.pluginSettings = pipeline.normalizePluginSettings();
    instance.perspectiveTargetsPath = () => "unused";
    instance.readPlatformConversationConfig = async () => ({ pre_text: "未保存", is_global: false });
    instance.platformGoApi = vi.fn(async () => {});
    instance.ensureHostConversationForPromptConfig = vi.fn(async () => ({ conversationId: "new", created: true, marker: "bootstrap" }));
    instance.removeHostPromptBootstrapTurn = vi.fn(async () => {});
    await expect(instance.updatePluginSettings("perspective-split", { enabled: true })).rejects.toThrow("平台未保存");
    expect(instance.pluginSettings.plugins["perspective-split"].enabled).toBe(false);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(instance.removeHostPromptBootstrapTurn).toHaveBeenCalledOnce();
    expect(instance.pluginSettingsBusy).toBe(false);
    expect(instance.conversationBusy).toBe(false);
  });
  it("prepares a real lobby conversation without a room and still refuses guest initialization", async () => {
    const instance = backend({ parseInviteWork: () => ({ id: "work" }) });
    instance.room = null;
    instance.conversation = { activeId: null, items: [] };
    instance.work = { suffix: "work" };
    instance.workGameUrl = () => "https://test/work";
    instance.keepGameSurfaceResident = vi.fn();
    instance.gameNetworkCaptureReady = Promise.resolve();
    instance.isSameWorkPage = () => true;
    instance.clearGameIsolation = vi.fn();
    instance.appendSessionLog = vi.fn();
    instance.gameSurface = { webContents: { getURL: () => "https://test/work", executeJavaScript: vi.fn(async () => ({ conversationId: "created-session", stopClicked: true })) } };
    instance.refreshConversations = async () => ({ activeId: "created-session", items: [{ id: "created-session", name: "新会话" }] });
    instance.persistSaveAnchor = vi.fn();
    await expect(instance.ensureHostConversationForPromptConfig({ allowLobby: true })).resolves.toMatchObject({ created: true, conversationId: "created-session" });
    expect(instance.room).toBeNull();
    expect(instance.conversation.activeId).toBe("created-session");
    instance.room = { role: "guest" };
    await expect(instance.ensureHostConversationForPromptConfig({ allowLobby: true })).rejects.toThrow("只有房主");
  });
  it("reports a deferred prefix when no work is selected without touching old sessions", async () => {
    const instance = backend();
    instance.currentWorkAppId = () => null;
    instance.conversation = { activeId: null };
    await expect(instance.syncPerspectivePrefix({ enabled: true, settings: {} })).resolves.toEqual({ status: "deferred" });
  });
  it("recovers an existing page session before generating a bootstrap message", async () => {
    const instance = backend({ parseInviteWork: () => ({ id: "work" }) });
    const existingId = "12345678-abcd-4321-abcd-123456789012";
    instance.conversation = { activeId: null, items: [] };
    instance.work = { suffix: "work" };
    instance.workGameUrl = () => "https://test/work";
    instance.keepGameSurfaceResident = vi.fn();
    instance.gameNetworkCaptureReady = Promise.resolve();
    instance.isSameWorkPage = () => true;
    instance.clearGameIsolation = vi.fn();
    instance.appendSessionLog = vi.fn();
    instance.persistSaveAnchor = vi.fn();
    const evaluate = (source: string) => vm.runInNewContext(source, {
      localStorage: { getItem: () => JSON.stringify({ work: existingId }) },
      document: { querySelector: () => ({}), querySelectorAll: (selector: string) => selector === "#ai-chat-answer" ? [{}] : [] }
    });
    instance.gameSurface = { webContents: { getURL: () => "https://test/work", executeJavaScript: evaluate } };
    instance.refreshConversations = async () => ({ activeId: existingId, items: [{ id: existingId, name: "已有会话" }] });
    await expect(instance.ensureHostConversationForPromptConfig({ allowLobby: true })).resolves.toMatchObject({ conversationId: existingId, created: false, marker: null });
    instance.conversation.activeId = null;
    instance.gameSurface.webContents.executeJavaScript = (source: string) => vm.runInNewContext(source, {
      localStorage: { getItem: () => "{}" },
      document: { querySelector: () => ({}), querySelectorAll: (selector: string) => selector === "#ai-chat-answer" ? [{}] : [] }
    });
    await expect(instance.ensureHostConversationForPromptConfig({ allowLobby: true })).rejects.toThrow("已有内容但无法确认会话编号");
  });
  it("sends only each recipient's text and withholds missing projections", async () => {
    const instance = backend();
    instance.room = { id: "room", role: "host", memberChatIds: { a: "chat-a", b: "chat-b" } };
    instance.sendLargeRoomPacket = vi.fn(async () => {});
    await instance.broadcastRoomPacket("round-result", { perspectiveSplit: true, output: "HOST", perspectiveOutputs: { a: "A", b: "B" } }, true);
    const sent = instance.sendLargeRoomPacket.mock.calls;
    expect(sent[0][3]).toEqual({ perspectiveSplit: true, output: "A" });
    expect(sent[1][3]).toEqual({ perspectiveSplit: true, output: "B" });
    expect(split.personalizeResult({ perspectiveSplit: true, output: "SECRET" }, "unknown").output).toBe(split.WITHHELD_OUTPUT);
  });
  it("reruns output plugins on refresh without discarding the input plugin record", async () => {
    const instance = backend();
    const inputRun = { runId: "input-old", pluginId: "effect-judge", phase: pipeline.PLUGIN_PHASES.INPUT, status: "completed" };
    const staleOutputRun = { runId: "output-old", pluginId: split.PERSPECTIVE_PLUGIN_ID, phase: pipeline.PLUGIN_PHASES.OUTPUT, status: "completed" };
    Object.assign(instance, {
      account: { accountId: "a" },
      pluginSettings: pipeline.normalizePluginSettings({ version: 2, plugins: { "perspective-split": { enabled: true } } }),
      room: {
        id: "room", role: "host", status: "waiting", members,
        memberChatIds: { b: "chat-b" },
        round: { status: "collecting", submissions: {}, lastResult: { round: 4, output: "OLD", model: "old-model", pluginRuns: [inputRun, staleOutputRun] } }
      },
      messageOperationBusy: false,
      appendSessionLog: vi.fn(), emit: vi.fn(), detachSurface: vi.fn(), keepGameSurfaceResident: vi.fn(),
      performLatestPlatformMessageOperation: vi.fn(async () => ({ output: "NEW SOURCE", model: "new-model", points: { input: 2, output: 3, total: 5 } })),
      runPerspectivePlugin: vi.fn(async (_output: string, round: any) => {
        round.perspectiveSplit = true;
        round.perspectiveOutputs = { a: "OWN", b: "GUEST" };
        return { value: "OWN", run: { model: "split-model", points: { input: 1, output: 1, total: 2 } } };
      }),
      rememberPerspectiveView: vi.fn(async () => {}), loadSurfaceUrl: vi.fn(async () => {}), ensureGameSurfaceMounted: vi.fn(async () => {}),
      broadcastRoomPacket: vi.fn(async () => {})
    });
    const result = await instance.runHostMessageOperation("refresh", "");
    expect(result.output).toBe("OWN");
    expect(result.pluginRuns).toHaveLength(2);
    expect(result.pluginRuns[0]).toEqual(inputRun);
    expect(result.pluginRuns[1]).toMatchObject({ pluginId: split.PERSPECTIVE_PLUGIN_ID, phase: pipeline.PLUGIN_PHASES.OUTPUT, status: "completed" });
    expect(result.pluginRuns.some((run: any) => run.runId === "output-old")).toBe(false);
    expect(instance.runPerspectivePlugin).toHaveBeenCalledWith("NEW SOURCE", expect.any(Object));
  });
  it("releases the protected game presentation when a refresh fails", async () => {
    const instance = backend();
    Object.assign(instance, {
      account: { accountId: "a" },
      pluginSettings: pipeline.normalizePluginSettings({ version: 2, plugins: { "perspective-split": { enabled: true } } }),
      room: {
        id: "room", role: "host", status: "waiting", members: [{ id: "a" }], memberChatIds: {},
        round: { status: "collecting", submissions: {}, lastResult: { round: 1, output: "OLD", pluginRuns: [] } }
      },
      messageOperationBusy: false, perspectivePresentationBlocked: false,
      appendSessionLog: vi.fn(), emit: vi.fn(), detachSurface: vi.fn(), keepGameSurfaceResident: vi.fn(),
      performLatestPlatformMessageOperation: vi.fn(async () => { throw new Error("platform refresh failed"); })
    });
    await expect(instance.runHostMessageOperation("refresh", "")).rejects.toThrow("platform refresh failed");
    expect(instance.perspectivePresentationBlocked).toBe(false);
    expect(instance.keepGameSurfaceResident).toHaveBeenCalled();
    expect(instance.room.messageOperation).toMatchObject({ status: "error", error: "platform refresh failed" });
    expect(instance.messageOperationBusy).toBe(false);
  });
  it("retains the full response on the platform and only projects its history response", async () => {
    const instance = backend();
    const raw = { data: [{ id: "msg", answer: "ALL", query: "input", model: "model" }] };
    let listener: any;
    let finish: any;
    const done = new Promise(resolve => { finish = resolve; });
    const sendCommand = vi.fn(async (method: string, args: any) => {
      if (method === "Fetch.getResponseBody") return { body: JSON.stringify(raw), base64Encoded: false };
      if (method === "Fetch.fulfillRequest") finish(args);
      return {};
    });
    instance.room = { role: "host" };
    instance.perspectiveViews = { "app:conversation": { [split.outputFingerprint("ALL")]: "OWN" } };
    instance.gameSurface = { webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, on: (_: any, fn: any) => { listener = fn; }, sendCommand } } };
    await instance.installPerspectiveResponseFilter();
    listener(null, "Fetch.requestPaused", { requestId: "r", request: { url: "https://test/api/installed-apps/app/messages?conversation_id=conversation", method: "GET" }, responseStatusCode: 200, responseHeaders: [{ name: "Content-Encoding", value: "gzip" }] });
    const response: any = await done;
    expect(JSON.parse(Buffer.from(response.body, "base64").toString()).data[0]).toEqual({ id: "msg", answer: "OWN", query: "input", model: "model" });
    expect(raw.data[0]!.answer).toBe("ALL");
    expect(sendCommand.mock.calls.every(([method]) => !method.includes("POST"))).toBe(true);
  });
  it("keeps a canceled model operation private and preserves its known points", async () => {
    const instance = backend();
    instance.room = { members };
    instance.account = { accountId: "a" };
    instance.emit = vi.fn();
    instance.appendSessionLog = vi.fn();
    instance.preparePerspectiveRetryModels = vi.fn(async () => ({ originalModel: { provider: "old", name: "old" }, candidates: [
      { provider: "google", model: "gemini-flash", key: "google\0gemini-flash" },
      { provider: "deepseek", model: "deepseek-v4-flash", key: "deepseek\0deepseek-v4-flash" }
    ] }));
    instance.applyPerspectiveRetryModel = vi.fn(async (target: any) => target);
    instance.runPlatformAutomationModel = vi.fn(async () => { throw Object.assign(new Error("已取消模型请求"), { pluginRun: { attemptCount: 7, points: { total: 57 } } }); });
    const round: any = {};
    await expect(instance.runPerspectivePlugin("secret", round)).rejects.toMatchObject({ message: expect.stringContaining("已取消"), pluginRun: { withheld: true, attemptCount: 7, points: { total: 57 } } });
    expect(round.perspectiveSplit).toBe(true);
    expect(Object.keys(round.perspectiveOutputs)).toHaveLength(0);
    expect(instance.runPlatformAutomationModel).toHaveBeenCalledTimes(1);
    expect(instance.perspectiveProgress).toBeNull();
  });
});

describe("perspective retries use fresh background work sessions", () => {
  function automation(outcomes: string[]) {
    const windows: any[] = [];
    const sequence: string[] = [];
    class AutomationWindow {
      destroyed = false;
      index = windows.length;
      webContents = { executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("previousConversationId: String(previous")) {
          sequence.push(`reset:${this.index}`);
          return { reset: true, previousConversationId: `old-${this.index}`, clickedNewButton: true };
        }
        if (script.includes("ready: Boolean(document.querySelector('#ai-chat-input'))")) {
          sequence.push(`clean:${this.index}`);
          return { ready: outcomes[this.index] !== "dirty", questionCount: 0, answerCount: 0 };
        }
        if (script.includes("const modelInput =")) {
          sequence.push(`send:${this.index}`);
          if (outcomes[this.index] === "timeout") throw new Error("等待模型输出完成超时");
          return { output: outcomes[this.index] === "invalid" ? "bad json" : JSON.stringify(fixture()), model: "M", conversationId: `new-${this.index}`, points: { input: 2, output: 3, total: 5 } };
        }
        throw new Error("Unexpected automation script");
      }) };
      constructor(_options: any) {
        expect(windows.every(window => window.destroyed)).toBe(true);
        windows.push(this);
        sequence.push(`create:${this.index}`);
      }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; sequence.push(`destroy:${this.index}`); }
    }
    const instance = backend({ BrowserWindow: AutomationWindow });
    instance.origin = "https://test.example";
    instance.room = { members, role: "host" };
    instance.account = { accountId: "a" };
    instance.pluginSettings = pipeline.normalizePluginSettings({ plugins: { "perspective-split": { enabled: true } } });
    instance.appendSessionLog = vi.fn();
    instance.emit = vi.fn();
    instance.recordAutomaticModelUsage = vi.fn();
    instance.withAutoModel = async (_appId: string, _label: string, execute: any) => {
      const controller = new AbortController();
      return autoModels.runAutoModel({
        signal: controller.signal,
        loadModels: async () => autoModels.normalizeCatalog({ models: [
          { provider_name: "p", model_id: "deepseek-v4-flash" },
          { provider_name: "p", model_id: "gemini-3.5-flash" }
        ] }),
        execute: (context: any) => { sequence.push(`model:${context.attempt}:${context.model.model}`); return execute(context); },
        wait: async () => { if (windows.length >= outcomes.length && outcomes.at(-1) !== "success") controller.abort(); }
      });
    };
    instance.preparePerspectiveRetryModels = vi.fn(async () => {
      sequence.push("model-plan");
      return { originalModel: { provider: "old", name: "old" }, candidates: [
        { provider: "google", model: "gemini-flash", key: "google\0gemini-flash" },
        { provider: "deepseek", model: "deepseek-v4-flash", key: "deepseek\0deepseek-v4-flash" }
      ] };
    });
    instance.applyPerspectiveRetryModel = vi.fn(async (target: any, _base: any, attempt: number) => {
      sequence.push(`model:${attempt}:${target.model}`);
      return target;
    });
    instance.loadSurfaceUrl = vi.fn(async (window: any, url: string) => {
      expect(url).toBe(`https://test.example/zh/explore/installed/${split.PERSPECTIVE_APP_ID}`);
      sequence.push(`load:${window.index}`);
    });
    return { instance, windows, sequence };
  }
  it("reloads and creates a clean conversation after timeout and invalid JSON, then stops on success", async () => {
    const { instance, windows, sequence } = automation(["timeout", "invalid", "success"]);
    const round: any = { number: 1 };
    const output = sourceOf(fixture());
    const result = await instance.runPerspectivePlugin(output, round);
    expect(result.run).toMatchObject({ attemptCount: 3, points: { input: 4, output: 6, total: 10 }, pointsIncomplete: true });
    expect(result.run.attempts.map((item: any) => item.status)).toEqual(["error", "error", "completed"]);
    expect(sequence).toEqual([
      "model:1:deepseek-v4-flash", "create:0", "load:0", "reset:0", "load:0", "clean:0", "send:0", "destroy:0",
      "model:2:gemini-3.5-flash", "create:1", "load:1", "reset:1", "load:1", "clean:1", "send:1", "destroy:1",
      "model:3:deepseek-v4-flash", "create:2", "load:2", "reset:2", "load:2", "clean:2", "send:2", "destroy:2"
    ]);
    const sendScripts = windows.map(window => window.webContents.executeJavaScript.mock.calls.find(([script]: string[]) => script!.includes("const modelInput ="))[0]);
    expect(new Set(sendScripts).size).toBe(1);
    expect(result.value).toContain("小丽吃苹果");
    expect(result.value).not.toContain("小花玩游戏");
    expect(round.perspectiveOutputs.b).not.toContain("小丽吃苹果");
    expect(instance.perspectiveProgress).toBeNull();
  });
  it.each([1, 2])("stops immediately when attempt %i succeeds", async count => {
    const { instance, windows } = automation(count === 1 ? ["success"] : ["invalid", "success"]);
    const result = await instance.runPerspectivePlugin(sourceOf(fixture()), {});
    expect(windows).toHaveLength(count);
    expect(result.run).toMatchObject({ attemptCount: count, points: { total: 5 * count }, pointsIncomplete: false });
    expect(windows.every(window => window.destroyed)).toBe(true);
  });
  it("does not send into a dirty session and retries in a different window", async () => {
    const { instance, windows, sequence } = automation(["dirty", "success"]);
    const result = await instance.runPerspectivePlugin(sourceOf(fixture()), {});
    expect(windows).toHaveLength(2);
    expect(sequence).not.toContain("send:0");
    expect(result.run.attemptCount).toBe(2);
  });
  it("cancels repeated failures without exposing the source through the output pipeline", async () => {
    const { instance, windows } = automation(["timeout", "invalid", "invalid"]);
    const round: any = { number: 1 };
    await instance.runConversationPluginStack(pipeline.PLUGIN_PHASES.OUTPUT, "ALL PRIVATE SOURCE", round);
    expect(windows).toHaveLength(3);
    expect(round.pluginRuns[0]).toMatchObject({ status: "error", withheld: true, attemptCount: 3 });
    expect(Object.keys(round.perspectiveOutputs)).toHaveLength(0);
    for (const member of members) {
      expect(split.personalizeResult({ perspectiveSplit: round.perspectiveSplit, perspectiveOutputs: round.perspectiveOutputs, output: "ALL PRIVATE SOURCE" }, member.id).output).toBe(split.WITHHELD_OUTPUT);
    }
    expect(instance.pluginPipelineBusy).toBe(false);
  });
  it("destroys a stalled window when its hard deadline expires", async () => {
    const { instance, windows } = automation(["success"]);
    instance.loadSurfaceUrl = () => new Promise(() => {});
    await expect(instance.runPlatformAutomationAttempt(split.PERSPECTIVE_APP_ID, "input", "独立视角", { timeoutMs: 15 })).rejects.toThrow("后台请求超时");
    expect(windows).toHaveLength(1);
    expect(windows[0].destroyed).toBe(true);
  });
});

describe("work configuration protection", () => {
  it("excludes account metadata and preserves untouched configuration", () => {
    const current = { pre_prompt: "原文", pre_text: "前置", account_id: "secret", id: "id" };
    const visible = settings.publicGlobalConfig(current);
    expect(visible).toEqual({ pre_prompt: "原文", pre_text: "前置" });
    expect(settings.changedGlobalFields(visible, visible, { ...visible, pre_prompt: "修改" })).toEqual({ pre_prompt: "修改" });
    expect(settings.countConfigCharacters({ a: "😀汉字" })).toBe(3);
  });
  it("rejects stale edits, metadata writes, type changes and removed fields", () => {
    expect(() => settings.changedGlobalFields({ pre_prompt: "新的" }, { pre_prompt: "旧的" }, { pre_prompt: "修改" })).toThrow("刷新");
    expect(() => settings.changedGlobalFields({}, {}, { account_id: "id" })).toThrow();
    expect(() => settings.changedGlobalFields({ pre_prompt: "a" }, { pre_prompt: "a" }, { pre_prompt: {} })).toThrow();
    expect(() => settings.changedGlobalFields({ pre_prompt: "a" }, { pre_prompt: "a" }, {})).toThrow();
  });
});
