import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { OnlineWorldService, workReference } = require("../electron/online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("../electron/online-world-crypto.cjs");
const { assembleCommentRecords, signRecord } = require("../electron/online-world-protocol.cjs");
const { createWorld } = require("../electron/grid-world-game.cjs");
const { packProgram } = require("../electron/online-world-runtime.cjs");

function service(options: Record<string, unknown>) {
  return new OnlineWorldService({
    requestGo: async () => ({ data: { world_book: [] } }),
    requestModel: async () => ({ answer: "{}" }),
    getOrigin: () => "https://aigirlfriend.baby",
    onChange: () => {},
    ...options
  });
}

describe("online world platform service", () => {
  it("calibrates rule time from the platform response clock", async () => {
    let localTime = 1_000_000;
    const instance = service({ now: () => localTime, monotonicNow: () => localTime, readPlatformTime: async () => 1_005_000, getAccount: () => ({ accountId: "a" }) });
    await instance.calibrateClock();
    expect(instance.now()).toBe(1_005_000);
    localTime += 2500;
    expect(instance.now()).toBe(1_007_500);
    expect(instance.summary().clock.source).toBe("platform-date");
  });

  it("normalizes only installed-work links", () => {
    expect(workReference("https://aigirlfriend.baby/zh/explore/installed/4ac2ab60-67ff-459d-ae9a-6274f1802195", "https://aigirlfriend.baby").workId).toBe("4ac2ab60-67ff-459d-ae9a-6274f1802195");
    expect(() => workReference("https://aigirlfriend.baby/zh/app/abc/configuration", "https://aigirlfriend.baby")).toThrow(/已安装作品/);
  });

  it("initializes an author season with signed, comment-sized control and snapshot records", async () => {
    const identity = generateOnlineWorldIdentity();
    const program = packProgram({ gameId: "cc.aiero.fyow.grid-conquest", title: "烽火慧眼", html: "<!doctype html><html><head></head><body><script>parent.postMessage({source:'fyow-grid-conquest',type:'ready'},'*')</script></body></html>" });
    const comments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/installed-apps/")) return { data: { id: "4ac2ab60-67ff-459d-ae9a-6274f1802195", name: "烽火慧眼", description: program.envelope, created_by_account_id: "author" } };
        if (endpoint.startsWith("/comments/") && options.method !== "POST") return { data: { items: [] } };
        if (endpoint.startsWith("/comments/") && options.method === "POST") {
          const item = { id: `c${comments.length + 1}`, account_id: "author", is_author: true, content: options.body.content };
          comments.push(item);
          return item;
        }
        throw new Error(`unexpected ${endpoint}`);
      }
    });
    await instance.open({ workUrl: "https://aigirlfriend.baby/zh/explore/installed/4ac2ab60-67ff-459d-ae9a-6274f1802195" });
    const state = await instance.initialize();
    instance.close();
    expect(state.initialized).toBe(true);
    expect(comments.every(item => item.content.length <= 1000)).toBe(true);
    const records = assembleCommentRecords(comments).records.map((item: any) => item.record);
    expect(records.some((record: any) => record.schema === "fyow.control/3")).toBe(true);
    expect(records.some((record: any) => record.schema === "fyow.snapshot/3" && record.state.width === 64)).toBe(true);
  });

  it("uses a comment reply as a wake-up and reads only the matching encrypted private chat", async () => {
    const senderIdentity = generateOnlineWorldIdentity();
    const receiverIdentity = generateOnlineWorldIdentity();
    const wakeComments: any[] = [];
    const directMessages: any[] = [];
    const world = createWorld({ authorityAccountId: "authority" });
    world.players.sender = { accountId: "sender", displayName: "甲", position: { x: 1, y: 1 }, deviceSigningPublicKey: senderIdentity.signingPublicKey, deviceEncryptionPublicKey: senderIdentity.encryptionPublicKey, commentRootId: "sender-root" };
    world.players.receiver = { accountId: "receiver", displayName: "乙", position: { x: 2, y: 2 }, deviceSigningPublicKey: receiverIdentity.signingPublicKey, deviceEncryptionPublicKey: receiverIdentity.encryptionPublicKey, commentRootId: "receiver-root" };
    world.players.sender.carriedGeneralIds = ["g1"];
    world.generals.g1 = { id: "g1", name: "青禾", holderAccountId: "sender", loyalToAccountId: "receiver", capturedFromAccountId: "receiver", status: "carried" };
    const control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    const sender = service({
      getAccount: () => ({ accountId: "sender", username: "甲" }),
      getIdentity: async () => senderIdentity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/comments/") && options.method === "POST") {
          const item = { id: `w${wakeComments.length + 1}`, account_id: "sender", content: options.body.content };
          wakeComments.push(item);
          return item;
        }
        if (endpoint === "/chats?page=1&limit=500") return { data: { chats: [{ id: "chat-1", other_account: { id: "receiver" } }] } };
        if (endpoint === "/chats/messages" && options.method === "POST") {
          directMessages.push({ id: `m${directMessages.length + 1}`, account_id: "sender", content: options.body.content });
          return { id: directMessages.at(-1).id };
        }
        throw new Error(`unexpected sender endpoint ${endpoint}`);
      }
    });
    sender.work = { id: "work", authorAccountId: "authority" };
    sender.control = control;
    sender.world = world;
    const sent = await sender.sendDirect("receiver", "captured-general-letter", { generalId: "g1", text: "请转告旧主，我仍记得故国。" });
    expect(sent.chunks).toBeGreaterThan(0);
    expect(directMessages.every(item => item.content.length <= 1000)).toBe(true);

    const receiver = service({
      getAccount: () => ({ accountId: "receiver", username: "乙" }),
      getIdentity: async () => receiverIdentity,
      requestConsole: async (endpoint: string) => {
        if (endpoint === "/comments/branches/receiver-root") return { data: wakeComments };
        if (endpoint === "/chats?page=1&limit=500") return { data: { chats: [{ id: "chat-1", other_account: { id: "sender" } }] } };
        if (endpoint.startsWith("/chats/messages?chat_id=chat-1")) return { data: directMessages };
        throw new Error(`unexpected receiver endpoint ${endpoint}`);
      }
    });
    receiver.work = { id: "work", authorAccountId: "authority" };
    receiver.control = control;
    receiver.world = world;
    const received = await receiver.receiveDirectWakes();
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("captured-general-letter");
    expect(received[0].payload.generalId).toBe("g1");
    expect(await receiver.receiveDirectWakes()).toHaveLength(0);
  });

  it("rejects forged direct-message types and captured-general letters not carried by the sender", async () => {
    const identity = generateOnlineWorldIdentity();
    const receiverIdentity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority" });
    world.players.sender = { accountId: "sender", displayName: "甲", position: { x: 1, y: 1 }, carriedGeneralIds: [], deviceSigningPublicKey: identity.signingPublicKey, deviceEncryptionPublicKey: identity.encryptionPublicKey, commentRootId: "sender-root" };
    world.players.receiver = { accountId: "receiver", displayName: "乙", position: { x: 2, y: 2 }, deviceSigningPublicKey: receiverIdentity.signingPublicKey, deviceEncryptionPublicKey: receiverIdentity.encryptionPublicKey, commentRootId: "receiver-root" };
    world.generals.g1 = { id: "g1", name: "青禾", holderAccountId: "sender", loyalToAccountId: "receiver", capturedFromAccountId: "receiver", status: "deployed" };
    const instance = service({ getAccount: () => ({ accountId: "sender", username: "甲" }), getIdentity: async () => identity, requestConsole: async () => { throw new Error("validation should stop before network"); } });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    await expect(instance.sendDirect("sender", "diplomacy", { text: "test" })).rejects.toThrow(/另一名/);
    await expect(instance.sendDirect("receiver", "arbitrary-command", { text: "test" })).rejects.toThrow(/不支持/);
    await expect(instance.sendDirect("receiver", "captured-general-letter", { generalId: "g1", text: "伪造书信" })).rejects.toThrow(/带在身边/);
    instance.directSendTimes = Array(12).fill(instance.now());
    await expect(instance.sendDirect("receiver", "diplomacy", { text: "频率测试" })).rejects.toThrow(/过于频繁/);
  });

  it("ignores signed intents bound to another work or game", async () => {
    const authorityIdentity = generateOnlineWorldIdentity();
    const playerIdentity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "shared-season" });
    const instance = service({ getAccount: () => ({ accountId: "authority", username: "服主" }), getIdentity: async () => authorityIdentity, requestConsole: async () => { throw new Error("foreign intent must not publish"); } });
    instance.work = { id: "current-work", authorAccountId: "authority" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    const base = { schema: "fyow.intent/3", intentId: "foreign", seasonId: world.seasonId, actorAccountId: "player", idempotencyKey: "foreign-join", intent: { type: "join", displayName: "串局玩家" }, deviceSigningPublicKey: playerIdentity.signingPublicKey, deviceEncryptionPublicKey: playerIdentity.encryptionPublicKey, createdAt: 1 };
    const foreignWork = signRecord({ ...base, workId: "another-work", gameId: "cc.aiero.fyow.grid-conquest" }, playerIdentity.signingPrivateKey);
    const foreignGame = signRecord({ ...base, intentId: "foreign-game", idempotencyKey: "foreign-game-join", workId: "current-work", gameId: "another-game" }, playerIdentity.signingPrivateKey);
    await instance.processPendingIntents([{ record: foreignWork, sources: [{ account_id: "player" }] }, { record: foreignGame, sources: [{ account_id: "player" }] }]);
    expect(instance.world.players.player).toBeUndefined();
    expect(instance.world.revision).toBe(0);
  });

  it("rate-limits local intent submission before signing or network access", async () => {
    const world = createWorld({ authorityAccountId: "authority" });
    const instance = service({ getAccount: () => ({ accountId: "player", username: "玩家" }), getIdentity: async () => { throw new Error("rate limit must run first"); }, requestConsole: async () => { throw new Error("rate limit must run first"); } });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    instance.intentSubmitTimes = Array(30).fill(instance.now());
    await expect(instance.submitIntent({ type: "join", displayName: "玩家", orientation: "any" })).rejects.toThrow(/过于频繁/);
  });

  it("does not publish a reset redirect when migration configuration verification fails", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author" });
    const postedComments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps/old/model-config/export") return { data: { name: "烽火慧眼", desc: "program", prpt: "world", pretxt: "prefix", posttxt: "post", world_book: [] } };
        if (endpoint === "/apps" && options.method === "POST") return { data: { app: { id: "new-work-id" } } };
        if (endpoint === "/apps/new-work-id/model-config" && options.method === "POST") throw new Error("fixture import rejected");
        if (endpoint.startsWith("/comments/") && options.method === "POST") { postedComments.push(options.body); return { id: "comment" }; }
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      }
    });
    instance.work = { id: "old", name: "烽火慧眼", description: "program", authorAccountId: "author" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey };
    instance.world = world;
    const result = await instance.exportMigrationDraft();
    expect(result.redirectPublished).not.toBe(true);
    expect(result.requiresConfigurationImport).toBe(true);
    expect(result.importError).toContain("fixture import rejected");
    expect(postedComments).toHaveLength(0);
  });

  it("initializes the copied ledger before publishing a verified reset redirect", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    const exportData = { name: "烽火慧眼", desc: "program", prpt: "world", pretxt: "prefix", posttxt: "post", world_book: [] };
    const comments: Array<{ endpoint: string; content: string }> = [];
    let oldSavedName = "";
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps/old/model-config/export") return oldSavedName ? { data: { ...exportData, name: oldSavedName } } : { data: exportData };
        if (endpoint === "/apps" && options.method === "POST") return { data: { app: { id: "new" } } };
        if (endpoint === "/apps/new/model-config" && options.method === "POST") return { ok: true };
        if (endpoint === "/apps/new/model-config/export") return { data: exportData };
        if (endpoint === "/apps/old/model-config" && options.method === "POST") { oldSavedName = options.body.app.name; return { ok: true }; }
        if (endpoint.startsWith("/comments/") && options.method === "POST") { comments.push({ endpoint, content: options.body.content }); return { id: `c${comments.length}` }; }
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      }
    });
    instance.work = { id: "old", name: "烽火慧眼", description: "program", authorAccountId: "author" };
    instance.control = { schema: "fyow.control/3", id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId: "old", seasonId: world.seasonId, programHash: instance.currentProgramHash(), authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey, startedAt: world.startedAt, updatedAt: world.startedAt };
    instance.world = world;
    const result = await instance.exportMigrationDraft();
    expect(result.redirectPublished).toBe(true);
    expect(instance.work.id).toBe("new");
    const newRecords = assembleCommentRecords(comments.filter(item => item.endpoint === "/comments/new/1").map((item, index) => ({ id: `n${index}`, content: item.content }))).records.map((item: any) => item.record.schema);
    const oldRecords = assembleCommentRecords(comments.filter(item => item.endpoint === "/comments/old/1").map((item, index) => ({ id: `o${index}`, content: item.content }))).records.map((item: any) => item.record.schema);
    expect(newRecords).toContain("fyow.control/3");
    expect(newRecords).toContain("fyow.snapshot/3");
    expect(oldRecords).toContain("fyow.reset/3");
  });
});
