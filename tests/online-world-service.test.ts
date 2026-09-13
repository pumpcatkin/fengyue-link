import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { OnlineWorldService, workReference, normalizeWorkDetail, playerContextQualityIssue, generalGenerationQualityIssue } = require("../electron/online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("../electron/online-world-crypto.cjs");
const { assembleCommentRecords, signRecord } = require("../electron/online-world-protocol.cjs");
const { createWorld } = require("../electron/grid-world-game.cjs");
const { packProgram } = require("../electron/online-world-runtime.cjs");
const { createBundledGridCard } = require("../electron/online-world-card.cjs");

const completePersona = "慧眼之主出身边境商旅之家，熟悉乱世中的人情与资源流向。性格沉稳果断，重视承诺，也愿意倾听不同立场；志在建立能让追随者安身的领地，擅长观察人才、统筹物资与化解内部矛盾。面对强敌时谨慎布局，缺点是对亲近之人过度保护，偶尔会独自承担风险。立场上珍视忠诚与互惠，但不会容忍背叛。";
const completeAppearance = "一头柔软白发衬着醒目的猫耳，浅色眼眸在思考时显得专注。身形轻盈而挺拔，惯穿便于行动的深色短装与披风，腰间带着记录地图和物资的皮袋，整体气质安静、敏锐又带有亲和力。";
const completeSpeech = "说话语速平稳，习惯先听完对方再作判断；下达命令时简洁明确，私下交流则会使用温和的玩笑缓和紧张。";
const completeRelationship = "对愿意并肩承担风险的人逐步建立信任，重视长期陪伴、坦诚沟通与彼此尊重；会主动照顾亲近者，也希望对方保有独立意志。";
const completeGeneralSetting = ("出身：初将生于北境关城的军户之家，自幼熟悉边地烽火与军粮转运。外貌：黑发束起，目光锐利，常穿轻便札甲并携长弓。性格：沉稳守信，遇事先观察后决断，对部下严厉却愿意承担责任。志趣：希望结束沿途百姓反复迁徙的生活，建立秩序稳定的领地。军事能力：擅长守城、斥候调度、夜间伏击和有限兵力下的物资统筹，能够根据地形迅速调整阵线。弱点：过分重视承诺，面对旧部求援时容易冒险；不善公开表达感情。当前处境：旧主战败后带着残部寻找拥有慧眼的新主公，急需粮草和可信赖的落脚处。关系倾向：对真诚且尊重部属的女性主公会逐步放下戒心，以行动表达忠诚，并愿意发展深厚而平等的羁绊。").repeat(4).slice(0, 760);

function service(options: Record<string, unknown>) {
  let worldBook: any[] = [];
  let modelSequence = 0;
  return new OnlineWorldService({
    requestGo: async (_endpoint: string, request: any = {}) => {
      if (request.method === "POST" && Array.isArray(request.body?.world_book)) worldBook = request.body.world_book;
      return { data: { world_book: worldBook } };
    },
    requestModel: async (request: any) => ({
      conversationId: `conversation-${++modelSequence}`,
      answer: request?.task === "player.profile-context"
        ? JSON.stringify({ personaSummary: completePersona, appearanceSummary: completeAppearance, speechStyle: completeSpeech, relationshipApproach: completeRelationship })
        : request?.task === "general.memory.update"
          ? "{\"category\":\"speech\",\"summary\":\"与玩家谈论戏剧\",\"emotion\":\"愉快\",\"intimacyDelta\":1,\"compactMemory\":\"言谈：[1年]与玩家谈论戏剧\\n经历：暂无\"}"
          : request?.task === "general.dialogue" || request?.task === "general.captive-dialogue"
            ? "{\"reply\":\"愿与主公详谈。\",\"command\":null}"
            : JSON.stringify({ name: "初将", gender: "female", power: 320, setting: completeGeneralSetting })
    }),
    getOrigin: () => "https://aigirlfriend.baby",
    onChange: () => {},
    ...options
  });
}

describe("online world platform service", () => {
  it("rejects placeholder profile text and incomplete initial generals before committing them", () => {
    expect(playerContextQualityIssue({
      personaSummary: "名为茂密的猫亚人，除此之外玩家未提供更多信息。".repeat(6),
      appearanceSummary: completeAppearance,
      speechStyle: completeSpeech,
      relationshipApproach: completeRelationship
    })).toMatch(/占位措辞/);
    expect(playerContextQualityIssue({ personaSummary: completePersona, appearanceSummary: completeAppearance, speechStyle: completeSpeech, relationshipApproach: completeRelationship })).toBeNull();
    expect(generalGenerationQualityIssue({ name: "短将", gender: "female", power: 300, setting: "善战。" }, { gender: "female" })).toMatch(/600～1000/);
    expect(generalGenerationQualityIssue({ name: "初将", gender: "female", power: 320, setting: completeGeneralSetting }, { gender: "female" })).toBeNull();
  });

  it("repairs a legacy player's placeholder context without resetting their game", async () => {
    const instance = service({ getAccount: () => ({ accountId: "author", username: "服主" }) });
    instance.world = createWorld({ seed: "legacy", seasonId: "season", startedAt: 1_000_000, authorityAccountId: "author" });
    instance.world.players.author = { accountId: "author", displayName: "茂密", gold: 1000, position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [], joinedAt: 1_000_000 };
    instance.world.privatePlayers.author = { playerContext: { personaSummary: "未提供", appearanceSummary: "暂无", speechStyle: "未知", relationshipApproach: "待补充" } };
    instance.localPreferences.characterProfile = { id: "profile", displayName: "茂密", basicInfo: "猫亚人", appearance: "白色头发", info: "猫亚人，白色头发" };
    instance.localPreferences.playerContext = null;
    const repaired = await instance.ensureLocalPlayerContext();
    expect(repaired.personaSummary).toContain("慧眼之主");
    expect(playerContextQualityIssue(instance.localPreferences.playerContext)).toBeNull();
    expect(instance.world.privatePlayers.author.playerContext).toEqual(instance.localPreferences.playerContext);
    expect(instance.world.players.author.position).toEqual({ x: 1, y: 1 });
  });

  it("serializes model requests while forcing every input into a fresh conversation", async () => {
    const calls: string[] = [];
    const sentRequests: any[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const instance = service({
      requestModel: async (request: any) => {
        calls.push(request.task);
        sentRequests.push(request);
        if (request.task === "first") await firstGate;
        return { conversationId: `conversation-queue-${calls.length}`, answer: JSON.stringify({ task: request.task }) };
      }
    });
    const first = instance.requestStructuredModel({ task: "first", conversationId: "stale-conversation" });
    const second = instance.requestStructuredModel({ task: "second", conversation_id: "stale-conversation" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual(["first"]);
    releaseFirst();
    await expect(first).resolves.toEqual({ task: "first" });
    await expect(second).resolves.toEqual({ task: "second" });
    expect(calls).toEqual(["first", "second"]);
    expect(sentRequests.every(request => !("conversationId" in request) && !("conversation_id" in request))).toBe(true);
    expect(instance.modelConversationIds.size).toBe(2);
  });

  it("rejects a platform response that reuses an earlier model conversation", async () => {
    const instance = service({
      requestModel: async (request: any) => ({ conversationId: "reused-conversation", answer: JSON.stringify({ task: request.task }) })
    });
    await expect(instance.requestStructuredModel({ task: "first" }, { attempts: 1 })).resolves.toEqual({ task: "first" });
    await expect(instance.requestStructuredModel({ task: "second" }, { attempts: 1 })).rejects.toThrow(/复用了已经使用过的模型会话/);
  });

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
        ? { data: { id: card.companion.workId, name: "在线游戏世界", created_by_account_id: card.companion.authorAccountId } }
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

    const joinIntent = {
      type: "join", displayName: "服主", orientation: "women", characterProfileId: "profile-author",
      characterTags: ["傲娇", "勇敢", "冷静", "长发", "黑发", "红瞳", "高挑", "军装"],
      initialGeneralWish: "一名可靠的初始良将", idempotencyKey: "join-author"
    };
    const [result, duplicateResult] = await Promise.all([
      instance.submitIntent(joinIntent),
      instance.submitIntent({ ...joinIntent, idempotencyKey: "join-author-duplicate" })
    ]);
    const records = assembleCommentRecords(comments).records.map((item: any) => item.record);
    const mapDelta = records.find((record: any) => record.schema === "fyow.map-delta/1");
    expect(result.mapDelta.schema).toBe("fyow.map-delta/1");
    expect(duplicateResult.state.world.generals).toEqual(result.state.world.generals);
    expect(records).toHaveLength(1);
    expect(mapDelta).not.toHaveProperty("intent");
    expect(mapDelta).not.toHaveProperty("orientation");
    expect(mapDelta.participant).toEqual({ displayName: "服主", accountName: "服主" });
    expect(Object.values(mapDelta.changes.cells)).toHaveLength(1);
    expect(records.some((record: any) => ["fyow.intent/3", "fyow.event/3", "fyow.private-vault/3"].includes(record.schema))).toBe(false);
    expect(instance.world.privatePlayers.author.orientation).toBe("women");
    expect(instance.localEvents).toHaveLength(2);
    expect(instance.localEvents[0].type).toBe("join");
    expect(instance.localEvents[1].type).toBe("grant-general");
    expect(instance.localPreferences.playerContext).toMatchObject({
      personaSummary: expect.stringContaining("慧眼之主"),
      appearanceSummary: expect.stringContaining("猫耳"),
      speechStyle: expect.stringContaining("语速平稳"),
      relationshipApproach: expect.stringContaining("长期陪伴")
    });
    expect(instance.modelConversationIds.size).toBe(2);
  });

  it("restores a player position and private resources from a pre-overlay local save", () => {
    const now = 1_000_000;
    const world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: now });
    world.players.author = { accountId: "author", displayName: "服主", gold: null };
    world.cells["7,9"] = { ownerAccountId: "author", soldiers: 20, generalIds: [] };
    world.generals.g1 = {
      id: "g1", name: "青禾", status: "carried", holderAccountId: "author", loyalToAccountId: "author",
      setting: "善守城。", power: 300, location: { x: 7, y: 9 }, masterHistory: [], captivityHistory: []
    };
    const instance = service({ getAccount: () => ({ accountId: "author", username: "服主" }) });
    instance.world = world;
    instance.localEvents = [
      { type: "join", actorAccountId: "author", createdAt: now, result: { capital: { x: 7, y: 9 }, gold: 1800 } },
      { type: "train", actorAccountId: "author", createdAt: now + 1, result: { cost: 20 } },
      { type: "time-settle", actorAccountId: "author", createdAt: now + 2, result: { effects: [{ type: "mining-complete", accountId: "author", gold: 235 }] } }
    ];
    instance.restoreLocalOverlay({
      playerEpoch: 0, privatePlayers: {}, players: { author: { gold: 0 } }, generals: {}, jobs: {}, processedIntents: []
    });
    expect(instance.world.players.author).toMatchObject({
      position: { x: 7, y: 9 }, gold: 2015, fieldArmySoldiers: 0, carriedGeneralIds: ["g1"], joinedAt: now
    });
  });

  it("runs dialogue and memory world books in sequence and binds the compact memory to the general", async () => {
    const now = 1_000_000;
    const identity = generateOnlineWorldIdentity();
    let world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: now });
    world = require("../electron/grid-world-game.cjs").applyIntent(world, {
      type: "join", displayName: "主公甲", orientation: "women", characterProfileId: "profile-a",
      characterTags: ["沉稳"], initialGeneralWish: "良将", playerContext: { personaSummary: "慧眼之主" }, idempotencyKey: "join"
    }, { actorAccountId: "author", now }).state;
    world = require("../electron/grid-world-game.cjs").applyIntent(world, {
      type: "grant-general", generalId: "g1", name: "青禾", gender: "female", setting: "善守城。", power: 320,
      discoveryId: "grant", idempotencyKey: "grant"
    }, { actorAccountId: "author", authorityAccountId: "author", now }).state;
    const requestedTasks: string[] = [];
    const instance = service({
      now: () => now + 20_000,
      getAccount: () => ({ accountId: "author", username: "服主昵称" }),
      getIdentity: async () => identity,
      requestModel: async (request: any) => {
        requestedTasks.push(request.task);
        if (request.task === "general.dialogue") return { conversationId: "conversation-dialogue", answer: '{"reply":"愿与主公谈谈北境。","command":null}' };
        if (request.task === "general.memory.update") return { conversationId: "conversation-memory", answer: '{"category":"speech","summary":"与主公甲谈论北境","emotion":"振奋","intimacyDelta":2,"compactMemory":"言谈：[1年]与主公甲谈论北境，感到振奋。\\n经历：[1年]被主公甲发掘并提拔为将领"}' };
        throw new Error(`unexpected task ${request.task}`);
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = world;
    instance.localPreferences.characterProfileId = "profile-a";
    instance.localPreferences.playerContext = { displayName: "主公甲", personaSummary: "慧眼之主", appearanceSummary: "", speechStyle: "沉稳", relationshipApproach: "重视忠诚" };
    const result = await instance.submitIntent({ type: "talk-general", generalId: "g1", topic: "北境局势", idempotencyKey: "talk" });
    expect(requestedTasks).toEqual(["general.dialogue", "general.memory.update"]);
    expect(result.dialogue.memory).toMatchObject({ category: "speech", intimacyDelta: 2 });
    expect(instance.world.generals.g1.memoryText).toContain("与主公甲谈论北境");
    expect(instance.world.generals.g1.interactionHistory.at(-1)).toMatchObject({ category: "speech", emotion: "振奋" });
  });

  it("does not commit a new player until the initial general model returns a complete setting", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: 1_000 });
    let modelSequence = 0;
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestModel: async (request: any) => request?.task === "player.profile-context"
        ? { conversationId: `conversation-${++modelSequence}`, answer: JSON.stringify({ personaSummary: completePersona, appearanceSummary: completeAppearance, speechStyle: completeSpeech, relationshipApproach: completeRelationship }) }
        : { conversationId: `conversation-${++modelSequence}`, answer: "模型暂时没有返回完整设定" },
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/comments/") && options.method === "POST") return { id: "c1", account_id: "author", is_author: true, created_at: new Date(2_000).toISOString(), content: options.body.content };
        throw new Error(`unexpected ${endpoint}`);
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey };
    instance.world = world;
    await expect(instance.submitIntent({
      type: "join", displayName: "服主", orientation: "women", characterProfileId: "profile-author",
      characterTags: [{ tag: "成熟", note: "可靠" }], initialGeneralWish: "一名可靠的初始良将", idempotencyKey: "failed-initial"
    })).rejects.toThrow(/初始将领生成/);
    expect(instance.world.players.author).toBeUndefined();
    expect(instance.localPreferences.characterTags).toEqual([]);
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

  it("lets only the companion author publish signed ban and reset directives", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    world.players.author = { accountId: "author", accountName: "author@example", displayName: "服主", gold: 1000, position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    world.players.target = { accountId: "target", accountName: "target@example", displayName: "目标", gold: 1000, position: { x: 2, y: 2 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    world.cells["2,2"] = { ownerAccountId: "target", soldiers: 10, generalIds: [] };
    const comments: any[] = [];
    let tick = 1;
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "author@example" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/comments/") && options.method === "POST") {
          const item = { id: `admin-${comments.length + 1}`, account_id: "author", is_author: true, created_at: new Date(1_000 + tick++).toISOString(), content: options.body.content };
          comments.push(item); return item;
        }
        throw new Error(`unexpected ${endpoint}`);
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey };
    instance.world = world;
    const banned = await instance.administer({ type: "player-ban", targetAccountId: "target" });
    expect(banned.state.world.bans.target).toMatchObject({ displayName: "目标", accountName: "target@example", banned: true });
    expect(comments.map((item: any) => item.content).join("\n")).toContain("FYOW3");
    expect(comments.length).toBeGreaterThan(1);
    const unbanned = await instance.administer({ type: "player-unban", targetAccountId: "target" });
    expect(unbanned.state.world.bans.target.banned).toBe(false);
    const reset = await instance.administer({ type: "player-reset", targetAccountId: "target" });
    expect(reset.state.world.players.target).toBeUndefined();
    expect(reset.state.world.cells["2,2"]).toBeUndefined();
    expect(reset.state.world.playerEpochs.target).toBe(1);
    const nonAuthor = service({ getAccount: () => ({ accountId: "target", username: "target@example" }), getIdentity: async () => identity });
    nonAuthor.work = instance.work; nonAuthor.control = instance.control; nonAuthor.world = world;
    await expect(nonAuthor.administer({ type: "player-ban", targetAccountId: "author" })).rejects.toThrow(/作者/);
  });

  it("ignores a banned player map delta and stale player epoch", () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    world.bans.target = { accountId: "target", banned: true };
    world.playerEpochs.target = 1;
    const instance = service({ getAccount: () => ({ accountId: "author", username: "author" }), requestConsole: async () => { throw new Error("local merge"); } });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = world;
    const record = signRecord({ schema: "fyow.map-delta/1", mapDeltaId: "old", gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season", actorAccountId: "target", playerEpoch: 0, participant: { displayName: "目标" }, changes: { cells: { "1,1": { ownerAccountId: "target", soldiers: 1, generalIds: [] } }, generals: {} }, deviceSigningPublicKey: identity.signingPublicKey, deviceEncryptionPublicKey: identity.encryptionPublicKey }, identity.signingPrivateKey);
    expect(instance.applyMapDeltas([{ record, sources: [{ id: "old-comment", account_id: "target", created_at: "2026-09-13T01:00:00Z" }] }])).toBe(0);
    expect(instance.world.cells["1,1"]).toBeUndefined();
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
