import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { OnlineWorldService, workReference, normalizeWorkDetail } = require("../electron/online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("../electron/online-world-crypto.cjs");
const { assembleCommentRecords, signRecord } = require("../electron/online-world-protocol.cjs");
const { createWorld } = require("../electron/grid-world-game.cjs");
const { packProgram } = require("../electron/online-world-runtime.cjs");
const { createBundledGridCard } = require("../electron/online-world-card.cjs");

function service(options: Record<string, unknown>) {
  let worldBook: any[] = [];
  return new OnlineWorldService({
    requestGo: async (_endpoint: string, request: any = {}) => {
      if (request.method === "POST" && Array.isArray(request.body?.world_book)) worldBook = request.body.world_book;
      return { data: { world_book: worldBook } };
    },
    requestModel: async () => ({ answer: "{\"name\":\"初将\",\"gender\":\"female\",\"power\":320,\"setting\":\"善守城，重信义。\"}" }),
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

  it("resolves the platform author from the nested installed-app app record", () => {
    const workId = "b27218e6-80f9-4c0d-91c7-4b8f87d47be8";
    const detail = normalizeWorkDetail({
      id: workId,
      app: {
        id: workId,
        name: "艳猎征途[b27218e680f94c0d]",
        created_by_account_id: "39404f0e-7678-45a1-86c6-9a21116bacbd"
      }
    }, workId);
    expect(detail.id).toBe(workId);
    expect(detail.name).toContain("艳猎征途");
    expect(detail.authorAccountId).toBe("39404f0e-7678-45a1-86c6-9a21116bacbd");
  });

  it("marks the signed-in platform author as the server owner", async () => {
    const card = createBundledGridCard();
    const authorAccountId = "39404f0e-7678-45a1-86c6-9a21116bacbd";
    const instance = service({
      getAccount: () => ({ accountId: authorAccountId, username: "服主" }),
      requestConsole: async (endpoint: string) => endpoint.startsWith("/installed-apps/")
        ? { id: card.companion.workId, app: { id: card.companion.workId, name: card.companion.name, created_by_account_id: authorAccountId } }
        : { data: { items: [] } }
    });
    const state = await instance.open({ card, displayName: "服主", orientation: "any" });
    instance.close();
    expect(state.isAuthor).toBe(true);
    expect(state.isServerOwner).toBe(true);
    expect(state.work.authorAccountId).toBe(authorAccountId);
  });

  it("loads the verified program snapshot from the game card when the installed page omits its description", async () => {
    const card = createBundledGridCard();
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      requestConsole: async (endpoint: string) => endpoint.startsWith("/installed-apps/")
        ? { data: { id: card.companion.workId, name: "在线游戏世界" } }
        : { data: { items: [] } }
    });
    const state = await instance.open({ card, displayName: "玩家", orientation: "any" });
    instance.close();
    expect(state.program.source).toBe("card-package");
    expect(state.program.title).toBe("猎艳疆土");
    expect(state.work.name).toBe(card.companion.name);
  });

  it("initializes an author season with signed, comment-sized control and snapshot records", async () => {
    const identity = generateOnlineWorldIdentity();
    const program = packProgram({ gameId: "cc.aiero.fyow.grid-conquest", title: "艳猎征途", html: "<!doctype html><html><head></head><body><script>parent.postMessage({source:'fyow-grid-conquest',type:'ready'},'*')</script></body></html>" });
    const comments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/installed-apps/")) return { data: { id: "4ac2ab60-67ff-459d-ae9a-6274f1802195", name: "艳猎征途", description: program.envelope, created_by_account_id: "author" } };
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
    expect(records.some((record: any) => record.schema === "fyow.event/3" || record.schema === "fyow.private-vault/3")).toBe(false);
    const snapshot = records.find((record: any) => record.schema === "fyow.snapshot/3");
    expect(snapshot).not.toHaveProperty("authorityBox");
    expect(snapshot.state.privatePlayers).toBeUndefined();
  });

  it("keeps orientation and action history local and publishes only the resulting territory change", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: 1_000 });
    const comments: any[] = [];
    const platformTime = Date.parse("2026-09-13T05:10:20.000Z");
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/comments/") && options.method === "POST") {
          const item = { id: `c${String(comments.length + 1).padStart(3, "0")}`, account_id: "author", is_author: true, created_at: new Date(platformTime).toISOString(), content: options.body.content };
          comments.push(item);
          return item;
        }
        throw new Error(`unexpected ${endpoint}`);
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey };
    instance.world = world;

    const result = await instance.submitIntent({
      type: "join", displayName: "服主", orientation: "women", characterProfileId: "profile-author",
      characterTags: ["傲娇", "勇敢", "冷静", "长发", "黑发", "红瞳", "高挑", "军装"],
      initialGeneralWish: "一名可靠的初始良将", idempotencyKey: "join-author"
    });
    const records = assembleCommentRecords(comments).records.map((item: any) => item.record);
    const mapDelta = records.find((record: any) => record.schema === "fyow.map-delta/1");
    expect(result.mapDelta.schema).toBe("fyow.map-delta/1");
    expect(records).toHaveLength(1);
    expect(mapDelta).not.toHaveProperty("intent");
    expect(mapDelta).not.toHaveProperty("orientation");
    expect(mapDelta.participant).toEqual({ displayName: "服主" });
    expect(Object.values(mapDelta.changes.cells)).toHaveLength(1);
    expect(records.some((record: any) => ["fyow.intent/3", "fyow.event/3", "fyow.private-vault/3"].includes(record.schema))).toBe(false);
    expect(instance.world.privatePlayers.author.orientation).toBe("women");
    expect(instance.localEvents).toHaveLength(2);
    expect(instance.localEvents[0].type).toBe("join");
    expect(instance.localEvents[1].type).toBe("grant-general");
  });

  it("merges territory changes by platform comment timestamp and never publishes other players positions", () => {
    const earlyIdentity = generateOnlineWorldIdentity();
    const lateIdentity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season", startedAt: 1_000 });
    const instance = service({
      getAccount: () => ({ accountId: "authority", username: "服主" }),
      requestConsole: async () => { throw new Error("map merge is local"); }
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;
    const signedDelta = (actorAccountId: string, displayName: string, id: string, identity: any, fakeClientTime: number) => signRecord({
      schema: "fyow.map-delta/1", mapDeltaId: id, gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season", actorAccountId,
      participant: { displayName }, changes: { cells: { "4,5": { ownerAccountId: actorAccountId, soldiers: 1, generalIds: [] } }, generals: {} },
      deviceSigningPublicKey: identity.signingPublicKey, deviceEncryptionPublicKey: identity.encryptionPublicKey, createdAt: fakeClientTime
    }, identity.signingPrivateKey);
    const late = signedDelta("late", "后提交", "late-delta", lateIdentity, 1);
    const early = signedDelta("early", "先提交", "early-delta", earlyIdentity, 9_999_999_999_999);
    instance.applyMapDeltas([
      { record: late, sources: [{ id: "comment-2", account_id: "late", created_at: "2026-09-13T05:00:02.000Z" }] },
      { record: early, sources: [{ id: "comment-1", account_id: "early", created_at: "2026-09-13T05:00:01.000Z" }] }
    ]);
    expect(instance.world.cells["4,5"].ownerAccountId).toBe("late");
    expect(instance.world.players.early.position).toBeUndefined();
    expect(instance.world.players.late.position).toBeUndefined();
    expect(instance.publicMapOrder.timestamp).toBe(Date.parse("2026-09-13T05:00:02.000Z"));
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
    world.generals.g1 = { id: "g1", name: "青禾", holderAccountId: "sender", loyalToAccountId: "receiver", capturedFromAccountId: "receiver", status: "carried", masterHistory: [{ accountId: "receiver", fromYear: 1, toYear: 2 }] };
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
    const sent = await sender.sendDirect("receiver", "general-letter", { generalId: "g1", text: "请转告旧主，我仍记得故国。" }, { fromGeneralDialogue: true });
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
    expect(received[0].type).toBe("general-letter");
    expect(received[0].payload.generalId).toBe("g1");
    expect(await receiver.receiveDirectWakes()).toHaveLength(0);
  });

  it("rejects forged direct-message types and captured-general letters not carried by the sender", async () => {
    const identity = generateOnlineWorldIdentity();
    const receiverIdentity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority" });
    world.players.sender = { accountId: "sender", displayName: "甲", position: { x: 1, y: 1 }, carriedGeneralIds: [], deviceSigningPublicKey: identity.signingPublicKey, deviceEncryptionPublicKey: identity.encryptionPublicKey, commentRootId: "sender-root" };
    world.players.receiver = { accountId: "receiver", displayName: "乙", position: { x: 2, y: 2 }, deviceSigningPublicKey: receiverIdentity.signingPublicKey, deviceEncryptionPublicKey: receiverIdentity.encryptionPublicKey, commentRootId: "receiver-root" };
    world.generals.g1 = { id: "g1", name: "青禾", holderAccountId: "sender", loyalToAccountId: "receiver", capturedFromAccountId: "receiver", status: "deployed", location: { x: 4, y: 4 }, masterHistory: [{ accountId: "receiver", fromYear: 1, toYear: 2 }] };
    const instance = service({ getAccount: () => ({ accountId: "sender", username: "甲" }), getIdentity: async () => identity, requestConsole: async () => { throw new Error("validation should stop before network"); } });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    await expect(instance.sendDirect("sender", "diplomacy", { text: "test" })).rejects.toThrow(/另一名/);
    await expect(instance.sendDirect("receiver", "arbitrary-command", { text: "test" }, { fromGeneralDialogue: true })).rejects.toThrow(/书信/);
    await expect(instance.sendDirect("receiver", "general-letter", { generalId: "g1", text: "伪造书信" }, { fromGeneralDialogue: true })).rejects.toThrow(/可交互位置/);
    world.generals.g1.status = "carried";
    world.players.sender.carriedGeneralIds = ["g1"];
    instance.directSendTimes = Array(12).fill(instance.now());
    await expect(instance.sendDirect("receiver", "general-letter", { generalId: "g1", text: "频率测试" }, { fromGeneralDialogue: true })).rejects.toThrow(/过于频繁/);
  });

  it("ignores territory changes bound to another work or game", () => {
    const playerIdentity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "shared-season" });
    const instance = service({ getAccount: () => ({ accountId: "authority", username: "服主" }), requestConsole: async () => { throw new Error("foreign map change stays local"); } });
    instance.work = { id: "current-work", authorAccountId: "authority" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    const base = { schema: "fyow.map-delta/1", mapDeltaId: "foreign", seasonId: world.seasonId, actorAccountId: "player", participant: { displayName: "串局玩家" }, changes: { cells: { "1,1": { ownerAccountId: "player", soldiers: 1, generalIds: [] } }, generals: {} }, deviceSigningPublicKey: playerIdentity.signingPublicKey, deviceEncryptionPublicKey: playerIdentity.encryptionPublicKey };
    const foreignWork = signRecord({ ...base, workId: "another-work", gameId: "cc.aiero.fyow.grid-conquest" }, playerIdentity.signingPrivateKey);
    const foreignGame = signRecord({ ...base, mapDeltaId: "foreign-game", workId: "current-work", gameId: "another-game" }, playerIdentity.signingPrivateKey);
    instance.applyMapDeltas([{ record: foreignWork, sources: [{ id: "f1", account_id: "player", created_at: "2026-09-13T01:00:00Z" }] }, { record: foreignGame, sources: [{ id: "f2", account_id: "player", created_at: "2026-09-13T01:00:01Z" }] }]);
    expect(instance.world.cells["1,1"]).toBeUndefined();
    expect(instance.world.revision).toBe(0);
  });

  it("does not post a comment for an action that changes only local private state", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season" });
    world.players.player = { accountId: "player", displayName: "玩家", gold: 1000, fieldArmySoldiers: 0, carriedGeneralIds: [], position: { x: 1, y: 1 } };
    world.privatePlayers.player = { orientation: "any" };
    world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    let posted = false;
    const instance = service({ getAccount: () => ({ accountId: "player", username: "玩家" }), getIdentity: async () => identity, requestConsole: async () => { posted = true; throw new Error("private-only action should not post"); } });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    const result = await instance.submitIntent({ type: "start-mining", x: 1, y: 1, auto: true, idempotencyKey: "mine" });
    expect(result.mapDelta).toBeNull();
    expect(posted).toBe(false);
    expect(instance.localEvents.at(-1).type).toBe("start-mining");
  });

  it("does not publish a reset redirect when migration configuration verification fails", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author" });
    const postedComments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps/old/model-config/export") return { data: { name: "艳猎征途", desc: "program", prpt: "world", pretxt: "prefix", posttxt: "post", world_book: [] } };
        if (endpoint === "/apps" && options.method === "POST") return { data: { app: { id: "new-work-id" } } };
        if (endpoint === "/apps/new-work-id/model-config" && options.method === "POST") throw new Error("fixture import rejected");
        if (endpoint.startsWith("/comments/") && options.method === "POST") { postedComments.push(options.body); return { id: "comment" }; }
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      }
    });
    instance.work = { id: "old", name: "艳猎征途", description: "program", authorAccountId: "author" };
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
    const exportData = { name: "艳猎征途", desc: "program", prpt: "world", pretxt: "prefix", posttxt: "post", world_book: [] };
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
    instance.work = { id: "old", name: "艳猎征途", description: "program", authorAccountId: "author" };
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
