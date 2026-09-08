import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const management = require("../electron/conversation-management.cjs");
const runtimeUtils = require("../electron/runtime-utils.cjs");
function backend(overrides = {}) {
  const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
    ...management, ...runtimeUtils, URL, Buffer, console, setTimeout, clearTimeout,
    makePacket: (type: string, roomId: string, from: string, seq: number, payload: unknown) => ({ type, roomId, from, seq, payload }), ...overrides
  });
  const instance = Object.create(Backend.prototype);
  Object.assign(instance, {
    mode: "game", room: { id: "r", role: "guest", hostAccountId: "host", hostChatId: "chat", profile: { id: "guest" }, round: { number: 1, status: "collecting" } },
    window: { isDestroyed: () => false, webContents: { send: vi.fn() } }, gameSurfacePresentationLocks: 0,
    keepGameSurfaceResident: vi.fn(), detachSurface: vi.fn(), emit: vi.fn(), appendSessionLog: vi.fn(),
    captureGameFrame: vi.fn(), applyGameIsolation: vi.fn(async () => true), injectConversationPluginCards: vi.fn(), sendRoomPacket: vi.fn()
  });
  return instance;
}
const packet = (type: string, payload: unknown) => ({ type, payload, from: "host", roomId: "r" });

describe("guest output presentation", () => {
  it("withholds a fast guest reply through preparation, premature collecting, and verified synchronization", async () => {
    const instance = backend();
    instance.prepareGuestRoundInputWithRetries = vi.fn(async () => {
      expect(instance.gameSurfaceShouldPresent()).toBe(false);
      return { conversationId: "guest-save", terminationMode: "completed-before-stop" };
    });
    await instance.handleRoomPacket(packet("round-input", { round: 1, input: "query" }), "chat");
    expect(instance.window.webContents.send).toHaveBeenCalledWith("backend:game-frame", { reset: true });
    await instance.handleRoomPacket(packet("turn-state", { round: 1, status: "collecting" }), "chat");
    instance.mode = "game"; // A UI tab switch cannot bypass the barrier.
    expect(instance.gameSurfaceShouldPresent()).toBe(false);
    instance.syncGuestRoundResultWithRetries = vi.fn(async () => {
      expect(instance.gameSurfaceShouldPresent()).toBe(false);
      return { gameReady: true, conversation: { activeId: "guest-save" } };
    });
    instance.showCapturedGameSurface = vi.fn(async () => expect(instance.gameSurfaceShouldPresent()).toBe(true));
    await instance.handleRoomPacket(packet("round-result", { round: 1, input: "query", output: "host output" }), "chat");
    expect(instance.room.verifiedOutputRound).toBe(1);
    expect(instance.room.round.number).toBe(2);
    expect(instance.gameSurfaceShouldPresent()).toBe(true);
    expect(instance.sendRoomPacket.mock.calls.at(-1)[1].payload.status).toBe("ready");
  });
  it("keeps failed synchronization hidden, including after another collecting status", async () => {
    const instance = backend();
    instance.syncGuestRoundResultWithRetries = vi.fn(async () => { throw new Error("server mismatch"); });
    await instance.handleRoomPacket(packet("round-result", { round: 1, input: "query", output: "host output" }), "chat");
    expect(instance.room.round.status).toBe("error");
    await instance.handleRoomPacket(packet("turn-state", { round: 1, status: "collecting" }), "chat");
    instance.mode = "game";
    expect(instance.gameSurfaceShouldPresent()).toBe(false);
  });
  it.each(["processing-input", "generating", "processing-output"])("hides the native view during %s", async status => {
    const instance = backend();
    await instance.handleRoomPacket(packet("turn-state", { round: 1, status }), "chat");
    expect(instance.gameSurfaceShouldPresent()).toBe(false);
    expect(await instance.publishLiveGameSnapshot()).toBe(false);
  });
  it("never gates host output and releases room-local pending state on leave", () => {
    const instance = backend();
    instance.room.role = "host";
    instance.room.round.status = "generating";
    expect(instance.gameSurfaceShouldPresent()).toBe(true);
    instance.room = null;
    expect(instance.gameSurfaceShouldPresent()).toBe(true);
  });
  it("discards a capture that started before the guest barrier", async () => {
    const instance = backend();
    let finish!: (value: unknown) => void;
    instance.liveGameSurface = true;
    instance.gameSurface = { webContents: { isDestroyed: () => false, isLoadingMainFrame: () => false, capturePage: () => new Promise(resolve => { finish = resolve; }) } };
    const capture = instance.publishLiveGameSnapshot();
    instance.beginGuestOutputWait(1);
    finish({ isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toJPEG: () => Buffer.from("raw") });
    expect(await capture).toBe(false);
    expect(instance.window.webContents.send.mock.calls.every((call: any[]) => call[1].reset)).toBe(true);
  });
  it("rejects conversation mutations while linked", async () => {
    const instance = backend();instance.loggedIn = true;instance.work = {};
    await expect(instance.manageConversation("delete", "c")).rejects.toThrow("退出房间");
  });
});

describe("host packet authorization", () => {
  it("accepts a member turn only from that member's authenticated private chat", async () => {
    const instance = backend();
    instance.room = {
      id: "r",
      role: "host",
      status: "waiting",
      members: [{ id: "guest", displayName: "访客" }],
      memberChatIds: { guest: "guest-chat" },
      memberHistory: { guest: "ready" },
      round: { number: 1, status: "collecting", submissions: {} }
    };
    instance.broadcastRoundState = vi.fn();
    instance.maybeRunHostRound = vi.fn();
    const submission = { type: "turn-submit", from: "guest", roomId: "r", payload: { round: 1, text: "本轮输入" } };

    await instance.handleRoomPacket(submission, "another-chat");
    expect(instance.room.round.submissions.guest).toBeUndefined();

    await instance.handleRoomPacket(submission, "guest-chat");
    expect(instance.room.round.submissions.guest).toMatchObject({ displayName: "访客", text: "本轮输入" });
    expect(instance.broadcastRoundState).toHaveBeenCalledOnce();
  });
});

describe("real platform conversation operations", () => {
  const options = { appId: "work", id: "c", action: "rename", name: " 新名字 " };
  it("posts the exact rename button endpoint and verifies server readback", async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: { data: [{ id: "c", name: "旧" }] } }).mockResolvedValueOnce({}).mockResolvedValueOnce({ data: [{ id: "c", name: "新名字" }] });
    const result = await management.mutatePlatformConversation(api, options);
    expect(api.mock.calls[1]).toEqual(["/installed-apps/work/conversations/c/name", { method: "POST", body: { name: "新名字" } }]);
    expect(result.items[0].name).toBe("新名字");
    expect(api).toHaveBeenCalledTimes(3);
  });
  it("deletes through the platform endpoint and waits for the UUID to disappear", async () => {
    const old = { data: [{ id: "c", name: "旧" }] };
    const api = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce({}).mockResolvedValueOnce(old).mockResolvedValueOnce({ data: [] });
    const wait = vi.fn();
    expect((await management.mutatePlatformConversation(api, { ...options, action: "delete" }, { wait })).items).toEqual([]);
    expect(api.mock.calls[1]).toEqual(["/installed-apps/work/conversations/c", { method: "DELETE" }]);
    expect(wait).toHaveBeenCalledOnce();
  });
  it("does not treat malformed list data as a successful deletion or retry the mutation", async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: [{ id: "c", name: "旧" }] }).mockResolvedValueOnce({}).mockResolvedValue({ message: "error" });
    await expect(management.mutatePlatformConversation(api, { ...options, action: "delete" }, { wait: vi.fn() })).rejects.toThrow("无法确认结果");
    expect(api.mock.calls.filter(call => call[1]?.method === "DELETE")).toHaveLength(1);
  });
  it("rejects missing IDs, whitespace names and server errors without local success", async () => {
    const api = vi.fn().mockResolvedValue({ data: [] });
    await expect(management.mutatePlatformConversation(api, { ...options, name: " " })).rejects.toThrow("不能为空");
    expect(api).not.toHaveBeenCalled();
    await expect(management.mutatePlatformConversation(api, options)).rejects.toThrow("找不到");
    expect(api).toHaveBeenCalledOnce();
    api.mockReset().mockResolvedValueOnce({ data: [{ id: "c" }] }).mockRejectedValueOnce(new Error("forbidden"));
    await expect(management.mutatePlatformConversation(api, options)).rejects.toThrow("forbidden");
  });
  it("removes only matching work/UUID anchors across mirrors and leaves unrelated saves intact", () => {
    const store = { sessions: { a: { workSuffix: "mirror/work", conversationId: "c", name: "old" }, b: { workSuffix: "other", conversationId: "c", name: "keep" }, c: { workSuffix: "work", conversationId: "d", name: "keep" } }, hosts: { "mirror/work": { c: "a" }, other: { c: "b" }, work: { d: "c" } } };
    const resolve = (suffix: string) => suffix.split("/").at(-1);
    management.updateConversationAnchors(store, "work", "c", "new", resolve);
    expect(store.sessions.a.name).toBe("new");
    expect(store.sessions.b.name).toBe("keep");
    management.updateConversationAnchors(store, "work", "c", null, resolve);
    expect(store.sessions.a).toBeUndefined();
    expect(store.hosts["mirror/work"].c).toBeUndefined();
    expect(store.sessions.b.name).toBe("keep");
    expect(store.sessions.c.name).toBe("keep");
  });
});
