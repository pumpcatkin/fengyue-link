import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

function passwordVerifiers() {
  const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  const start = source.indexOf("function sha256Base64Url");
  const end = source.indexOf("function parseInviteWork", start);
  return vm.runInNewContext(`${source.slice(start, end)}; ({ derivePasswordVerifier, derivePasswordVerifierV2 })`, {
    crypto: require("node:crypto")
  });
}

function backend() {
  const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
    URL, Buffer, console, setTimeout, clearTimeout,
    crypto: require("node:crypto"), zlib: require("node:zlib"),
    OFFICIAL_RELEASE_PAGE: "https://github.com/pumpcatkin/fengyue-link/releases/latest",
    makePacket: (type: string, roomId: string, from: string, seq: number, payload: unknown) => ({
      id: `packet-${seq}`, type, roomId, from, seq, ts: Date.now(), payload
    })
  });
  const instance = Object.create(Backend.prototype);
  Object.assign(instance, {
    account: { accountId: "host" }, profileId: "default", appVersion: "0.12.8", seq: 0,
    seenPackets: new Set(), incomingTransfers: new Map(),
    appendSessionLog: vi.fn(), sendRoomPacket: vi.fn(async () => {})
  });
  return instance;
}

describe("protocol resource guards", () => {
  it("rejects a guest before password authentication when tool versions differ", async () => {
    const instance = backend();
    Object.assign(instance, {
      room: {
        id: "room-1", role: "host", status: "waiting", createdAt: Date.now() - 100,
        inviteAppId: "invite-1", removedMemberIds: new Set(), gameStarted: false,
        passwordVerifierV2: "verifier"
      },
      pendingChallenges: new Map()
    });
    await instance.handleRoomPacket({
      id: "hello-1", type: "hello", roomId: "pending", from: "guest", ts: Date.now(),
      payload: {
        appVersion: "0.12.7", inviteAppId: "invite-1", authSchemes: ["scrypt-v2"],
        profile: { id: "guest", platformName: "Guest", displayName: "Guest", basicInfo: "", appearance: "", info: "" }
      }
    }, "chat-1", { chat: { other_account: { id: "guest" } } });
    expect(instance.pendingChallenges.size).toBe(0);
    expect(instance.sendRoomPacket).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      type: "error",
      payload: expect.objectContaining({ code: "VERSION_MISMATCH", hostVersion: "0.12.8", guestVersion: "0.12.7" })
    }));
  });

  it("continues the authenticated handshake only when both tool versions match", async () => {
    const instance = backend();
    Object.assign(instance, {
      room: {
        id: "room-1", role: "host", status: "waiting", createdAt: Date.now() - 100,
        inviteAppId: "invite-1", removedMemberIds: new Set(), gameStarted: false,
        passwordVerifierV2: "verifier"
      },
      pendingChallenges: new Map()
    });
    await instance.handleRoomPacket({
      id: "hello-2", type: "hello", roomId: "pending", from: "guest", ts: Date.now(),
      payload: {
        appVersion: "0.12.8", inviteAppId: "invite-1", authSchemes: ["scrypt-v2"],
        profile: { id: "guest", platformName: "Guest", displayName: "Guest", basicInfo: "", appearance: "", info: "" }
      }
    }, "chat-1", { chat: { other_account: { id: "guest" } } });
    expect(instance.pendingChallenges.get("guest")).toMatchObject({ appVersion: "0.12.8", authScheme: "scrypt-v2" });
    expect(instance.sendRoomPacket).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      type: "challenge",
      payload: expect.objectContaining({ appVersion: "0.12.8", authScheme: "scrypt-v2" })
    }));
  });

  it("requires the visitor to update when the host handshake version differs", async () => {
    const instance = backend();
    Object.assign(instance, {
      emit: vi.fn(),
      room: {
        id: "PENDING", role: "guest", status: "joining", createdAt: Date.now() - 100,
        hostAccountId: "host", hostChatId: "chat-host", passwordVerifier: "legacy", passwordVerifierV2: "strong",
        profile: { id: "guest", platformName: "Guest", displayName: "Guest", basicInfo: "", appearance: "", info: "" }
      }
    });
    await instance.handleRoomPacket({
      id: "challenge-1", type: "challenge", roomId: "room-1", from: "host", ts: Date.now(),
      payload: { challenge: "nonce", authScheme: "scrypt-v2", appVersion: "0.12.7" }
    }, "chat-host");
    expect(instance.room.status).toBe("join-error");
    expect(instance.room.error).toContain("请更新访客端风月联机工具");
    expect(instance.room.versionMismatch).toMatchObject({ hostVersion: "0.12.7", guestVersion: "0.12.8", updateRequired: true });
    expect(instance.sendRoomPacket).not.toHaveBeenCalled();
  });

  it("derives a deterministic, identity-bound scrypt verifier distinct from the legacy verifier", () => {
    const derive = passwordVerifiers();
    const strong = derive.derivePasswordVerifierV2("Host-ID", "correct horse battery staple");
    expect(strong).toBe(derive.derivePasswordVerifierV2("host-id", "correct horse battery staple"));
    expect(strong).not.toBe(derive.derivePasswordVerifier("host-id", "correct horse battery staple"));
    expect(strong).not.toBe(derive.derivePasswordVerifierV2("another-host", "correct horse battery staple"));
    expect(strong).toHaveLength(43);
  });

  it("bounds the replay cache while retaining the newest packet ids", () => {
    const instance = backend();
    for (let index = 0; index < 10005; index += 1) instance.rememberSeenPacket(`packet-${index}`);
    expect(instance.seenPackets.size).toBe(10000);
    expect(instance.seenPackets.has("packet-0")).toBe(false);
    expect(instance.seenPackets.has("packet-10004")).toBe(true);
  });

  it("refuses an oversized uncompressed transfer before sending chunks", async () => {
    const instance = backend();
    await expect(instance.sendLargeRoomPacket("chat", "result", "room", "x".repeat(8 * 1024 * 1024))).rejects.toThrow("8 MiB");
    expect(instance.sendRoomPacket).not.toHaveBeenCalled();
  });

  it("caps decompression output and clears the completed transfer", async () => {
    const instance = backend();
    const encoded = require("node:zlib").gzipSync(Buffer.from(JSON.stringify("x".repeat(8 * 1024 * 1024)), "utf8")).toString("base64url");
    const parts = encoded.match(/.{1,7000}/g) || [];
    for (let index = 0; index < parts.length - 1; index += 1) {
      await instance.handleChunkPacket({
        from: "guest", roomId: "room",
        payload: { transferId: "transfer", kind: "result", index, total: parts.length, data: parts[index] }
      }, "chat");
    }
    await expect(instance.handleChunkPacket({
      from: "guest", roomId: "room",
      payload: { transferId: "transfer", kind: "result", index: parts.length - 1, total: parts.length, data: parts.at(-1) }
    }, "chat")).rejects.toThrow();
    expect(instance.incomingTransfers.size).toBe(0);
  });

  it("caps chat history without discarding an unsent message", () => {
    const instance = backend();
    const chat = {
      messages: Array.from({ length: 1005 }, (_, index) => ({ id: String(index) })),
      pendingBroadcasts: ["0"]
    };
    instance.trimRoomChatHistory(chat);
    expect(chat.messages).toHaveLength(1000);
    expect(chat.messages.some((message: { id: string }) => message.id === "0")).toBe(true);
    expect(chat.messages.some((message: { id: string }) => message.id === "1")).toBe(false);
  });

  it("backs off repeated idle room polls", async () => {
    const instance = backend();
    Object.assign(instance, {
      loggedIn: true,
      room: { role: "host", status: "waiting", createdAt: Date.now(), chat: {} },
      roomPollBusy: false, roomPollNotBefore: 0, roomPollIdleCount: 3,
      listPrivateChats: vi.fn(async () => [])
    });
    await instance.pollRoomProtocol();
    expect(instance.roomPollIdleCount).toBe(4);
    expect(instance.roomPollNotBefore - Date.now()).toBeGreaterThanOrEqual(1400);
  });

  it("abandons an in-flight poll cleanly when leaving the room", async () => {
    const instance = backend();
    Object.assign(instance, {
      loggedIn: true,
      room: { role: "host", status: "waiting", createdAt: Date.now(), chat: {} },
      roomPollBusy: false, roomPollNotBefore: 0, roomPollIdleCount: 0,
      listPrivateChats: vi.fn(async () => { instance.room = null; return []; })
    });
    await expect(instance.pollRoomProtocol()).resolves.toBeUndefined();
    expect(instance.appendSessionLog).not.toHaveBeenCalledWith("protocol-poll-error", expect.anything());
    expect(instance.roomPollBusy).toBe(false);
  });

  it("notifies every authenticated guest before the host room is dissolved", async () => {
    const instance = backend();
    Object.assign(instance, {
      loggedIn: true,
      room: {
        id: "room-1", role: "host",
        members: [{ id: "host" }, { id: "guest-1" }, { id: "guest-2" }],
        memberChatIds: { "guest-1": "chat-1", "guest-2": "chat-2" }
      },
      pendingChallenges: new Map(),
      detachSurface: vi.fn(), emit: vi.fn(),
      sendRoomPacketWithRetries: vi.fn(async () => true)
    });

    const result = await instance.leaveRoom();

    expect(instance.sendRoomPacketWithRetries).toHaveBeenCalledTimes(2);
    expect(instance.sendRoomPacketWithRetries.mock.calls.map((call: unknown[]) => call[1])).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "room-closed", roomId: "room-1", from: "host" })
    ]));
    expect(result).toEqual({ left: true, role: "host", notifiedGuests: 2 });
    expect(instance.room).toBeNull();
    expect(instance.emit).toHaveBeenCalledWith(expect.objectContaining({ roomDissolved: { roomId: "room-1", notifiedGuests: 2 } }));
  });

  it("keeps the host room active when any dissolution notice cannot be delivered", async () => {
    const instance = backend();
    const room = {
      id: "room-1", role: "host",
      members: [{ id: "host" }, { id: "guest-1" }, { id: "guest-2" }],
      memberChatIds: { "guest-1": "chat-1", "guest-2": "chat-2" }
    };
    Object.assign(instance, {
      loggedIn: true, room, pendingChallenges: new Map(),
      detachSurface: vi.fn(), emit: vi.fn(),
      sendRoomPacketWithRetries: vi.fn(async (chatId: string) => {
        if (chatId === "chat-2") throw new Error("offline");
        return true;
      })
    });

    await expect(instance.leaveRoom()).rejects.toThrow("暂未解散");
    expect(instance.room).toBe(room);
    expect(instance.detachSurface).not.toHaveBeenCalled();
  });

  it("forces a guest to leave after an authenticated host dissolution notice", async () => {
    const instance = backend();
    Object.assign(instance, {
      loggedIn: true,
      room: {
        id: "room-1", role: "guest", createdAt: Date.now() - 1000,
        hostAccountId: "host", hostChatId: "host-chat", profile: { id: "guest-1" }
      },
      pendingChallenges: new Map([['pending', {}]]),
      detachSurface: vi.fn(), emit: vi.fn()
    });

    await instance.handleRoomPacket({
      id: "close-1", type: "room-closed", roomId: "room-1", from: "host", ts: Date.now(),
      payload: { message: "房间已经解散", closedAt: Date.now() }
    }, "host-chat");

    expect(instance.room).toBeNull();
    expect(instance.pendingChallenges.size).toBe(0);
    expect(instance.emit).toHaveBeenCalledWith(expect.objectContaining({ roomClosed: expect.objectContaining({ message: "房间已经解散" }) }));
  });
});
