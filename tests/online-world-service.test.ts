import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { OnlineWorldService, workReference, normalizeWorkDetail, bindWorldAuthority, recordPlatformOrder, playerContextFromProfile, playerContextQualityIssue, generalGenerationQualityIssue, normalizeGeneratedGeneral, dialogueQualityIssue, compactDialogueReply, generalMemoryQualityIssue } = require("../electron/online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("../electron/online-world-crypto.cjs");
const { assembleCommentRecords, encodeCommentRecord, extractCommentItems, signRecord, canonicalJson, sha256 } = require("../electron/online-world-protocol.cjs");
const { createWorld, createFallbackGeneral, applyIntent, battleCasualties, generatedGeneralPower, staticCell } = require("../electron/grid-world-game.cjs");
const { packProgram } = require("../electron/online-world-runtime.cjs");
const { createBundledGridCard, rebindGameCard, configurationDigest, cardDigest } = require("../electron/online-world-card.cjs");
const { normalizeBalance } = require("../electron/grid-balance.cjs");
const { dailyRedTreasureBatch } = require("../electron/grid-world-game.cjs");

const completePersona = "慧眼之主出身边境商旅之家，熟悉乱世中的人情与资源流向。性格沉稳果断，重视承诺，也愿意倾听不同立场；志在建立能让追随者安身的领地，擅长观察人才、统筹物资与化解内部矛盾。面对强敌时谨慎布局，缺点是对亲近之人过度保护，偶尔会独自承担风险。立场上珍视忠诚与互惠，但不会容忍背叛。";
const completeAppearance = "一头柔软白发衬着醒目的猫耳，浅色眼眸在思考时显得专注。身形轻盈而挺拔，惯穿便于行动的深色短装与披风，腰间带着记录地图和物资的皮袋，整体气质安静、敏锐又带有亲和力。";
const completeSpeech = "说话语速平稳，习惯先听完对方再作判断；下达命令时简洁明确，私下交流则会使用温和的玩笑缓和紧张。";
const completeRelationship = "对愿意并肩承担风险的人逐步建立信任，重视长期陪伴、坦诚沟通与彼此尊重；会主动照顾亲近者，也希望对方保有独立意志。";
const completeGeneralSetting = ("出身：初将生于北境关城的军户之家，自幼熟悉边地烽火与军粮转运。外貌：黑发束起，目光锐利，常穿轻便札甲并携长弓。性格：沉稳守信，遇事先观察后决断，对部下严厉却愿意承担责任。志趣：希望结束沿途百姓反复迁徙的生活，建立秩序稳定的领地。军事能力：擅长守城、斥候调度、夜间伏击和有限兵力下的物资统筹，能够根据地形迅速调整阵线。弱点：过分重视承诺，面对旧部求援时容易冒险；不善公开表达感情。当前处境：旧主战败后带着残部寻找拥有慧眼的新主公，急需粮草和可信赖的落脚处。关系倾向：对真诚且尊重部属的女性主公会逐步放下戒心，以行动表达忠诚，并愿意发展深厚而平等的羁绊。").repeat(4).slice(0, 760);
const completeGeneralAppearance = "她有一头束成高马尾的乌黑长发，眉眼锐利而沉静，肤色是长期巡守留下的健康浅麦色。身形高挑结实，肩背线条利落，手掌留有拉弓和持枪形成的薄茧。她惯穿便于行动的深青札甲，腰间系红色旧绳作为故乡纪念，披风边缘缝着修补多次的银线，举止始终保持警觉而克制。";
const completeGeneral = { name: "初将", gender: "female", heightCm: 172, weightKg: 61.5, measurements: { chestCm: 89, waistCm: 64, hipCm: 91 }, appearanceSetting: completeGeneralAppearance, coreSetting: completeGeneralSetting.slice(0, 700), power: 320 };

function service(options: Record<string, unknown>) {
  let worldBook: any[] = [];
  let modelSequence = 0;
  return new OnlineWorldService({
    requestGo: async (endpoint: string, request: any = {}) => {
      if (endpoint.startsWith("/apps/config?")) return { data: { model: { provider: "fixture", name: "fixture-model", mode: "chat", completion_params: { stop: [] } } } };
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
            ? "{\"reply\":\"愿与主公详谈。\",\"narration\":\"她抬手整理袖口，微微颔首。\",\"command\":null,\"memoryUpdate\":{\"category\":\"speech\",\"summary\":\"与主公详谈\",\"emotion\":\"平静\",\"intimacyDelta\":1,\"compactMemory\":\"言谈：与主公详谈。\\n经历：暂无新的经历。\"}}"
            : JSON.stringify(completeGeneral)
    }),
    getOrigin: () => "https://aigirlfriend.baby",
    onChange: () => {},
    ...options
  });
}

function coverageHarness(workId = "work") {
  const identities: Record<string, any> = { author: generateOnlineWorldIdentity(), player: generateOnlineWorldIdentity() };
  const roots: any[] = [];
  const base = 1_800_000_000_000;
  let postTime = base + 200;
  let nextId = 0;
  const append = (record: any, actor: string, timestamp: number) => {
    const chunks = encodeCommentRecord(record);
    const root: any = { id: `root-${nextId++}`, account_id: actor, created_at: timestamp, content: chunks[0], children: [] };
    root.children = chunks.slice(1).map((content: string, index: number) => ({ id: `${root.id}-reply-${index}`, account_id: actor, created_at: timestamp + index + 1, content }));
    roots.push(root);
    return { record, root, sources: [root, ...root.children.map((reply: any) => ({ ...reply, _fyowRootId: root.id }))] };
  };
  const requestConsole = async (endpoint: string, options: any = {}) => {
    if (options.method === "POST") {
      const item = { id: `posted-${nextId++}`, account_id: "author", created_at: postTime++, ...options.body };
      if (options.body.parent_id) roots.find(root => root.id === options.body.parent_id).children.push(item);
      else roots.push({ ...item, children: [] });
      return item;
    }
    if (endpoint.includes("/branches/")) return [];
    const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
    return { data: roots.slice((page - 1) * 50, page * 50) };
  };
  const create = (accountId = "author") => {
    const instance = service({
      getAccount: () => ({ accountId }), getIdentity: async () => identities[accountId] || identities.player,
      requestConsole, now: () => base + 10_000
    });
    instance.work = { id: workId, authorAccountId: "author" };
    instance.status = "ready";
    return instance;
  };
  const author = create();
  author.control = signRecord({
    schema: "fyow.control/3", id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId, seasonId: "season",
    programHash: author.currentProgramHash(), authorityAccountId: "author", authoritySigningPublicKey: identities.author.signingPublicKey
  }, identities.author.signingPrivateKey);
  author.world = createWorld({ seed: "coverage", seasonId: "season", authorityAccountId: "author", startedAt: base });
  author.world.treasureEpoch = 1;
  author.world.treasureSpawns.old = { id: "old", epoch: 1, x: 1, y: 1, materialId: "white", spawnedAt: base };
  append(author.control, "author", base + 1);
  const snapshot = (state: any, time: number, coverage?: any) => {
    const publicState = JSON.parse(JSON.stringify(state));
    delete publicState.privatePlayers;
    return append(signRecord({
      schema: "fyow.snapshot/3", snapshotId: `snapshot-${time}`, gameId: author.world.gameId, workId, seasonId: "season",
      revision: state.revision || 0, state: publicState, stateHash: sha256(Buffer.from(canonicalJson(publicState))),
      ...(coverage ? { ledgerCoverage: coverage } : {})
    }, identities.author.signingPrivateKey), "author", base + time);
  };
  snapshot(author.world, 10, { version: 1, through: { timestamp: 0, commentId: "" } });
  const map = (actor: string, time: number, changes: any, extra: any = {}) => append(signRecord({
    schema: "fyow.map-delta/1", mapDeltaId: `map-${actor}-${time}`, gameId: author.world.gameId, workId, seasonId: "season",
    actorAccountId: actor, participant: { displayName: actor }, playerEpoch: 0,
    deviceSigningPublicKey: identities[actor].signingPublicKey,
    changes: { cells: {}, generals: {}, ...changes }, ...extra
  }, identities[actor].signingPrivateKey), actor, base + time);
  return { author, create, append, snapshot, map, roots, base, identities };
}

describe("online world platform service", () => {
  it("publishes signed balance settings that a fresh player reads from the cloud", async () => {
    const fixture = coverageHarness();
    fixture.author.retireBalanceDirectives = vi.fn(async () => ({ deleted: 0 }));
    const balance = normalizeBalance({ marchSeconds: 7, trainingDiscoveryPity: 50, dailyRedTime: "19:15" });
    await fixture.author.administerNow({ type: "balance-update", balance });
    expect(fixture.author.world.balance).toEqual(balance);
    expect(fixture.author.retireBalanceDirectives).toHaveBeenCalledOnce();
    const reader = fixture.create("player");
    await reader.sync(true);
    expect(reader.world.balance).toEqual(balance);
    expect(reader.state().balanceFields).toEqual([]);
    expect(fixture.author.state().balanceFields.length).toBeGreaterThan(70);
    await expect(reader.administerNow({ type: "balance-update", balance })).rejects.toThrow("作者");
    await expect(fixture.author.administerNow({ type: "balance-update", balance: { marchSeconds: -5 } })).rejects.toThrow();
  });

  it("retires only author directives covered by a confirmed replacement snapshot", async () => {
    const fixture = coverageHarness();
    const make = (id: string, type: string, extra: any = {}) => signRecord({
      schema: "fyow.authority/1", authorityId: id, gameId: fixture.author.world.gameId,
      workId: "work", seasonId: "season", authorityAccountId: "author", type,
      issuedAt: fixture.base + 20, ...extra
    }, fixture.identities.author.signingPrivateKey);
    const old = fixture.append(make("old-balance", "balance-update", { balance: normalizeBalance() }), "author", fixture.base + 20);
    const ban = fixture.append(make("ban", "player-ban", { targetAccountId: "player" }), "author", fixture.base + 30);
    const latest = fixture.append(make("new-balance", "balance-update", { balance: normalizeBalance({ marchSeconds: 8 }) }), "author", fixture.base + 50);
    const uncovered = fixture.append(make("uncovered", "player-unban", { targetAccountId: "player" }), "author", fixture.base + 40);
    const snapshot = fixture.snapshot(fixture.author.world, 60, {
      version: 1, through: recordPlatformOrder(ban), appliedAuthorityIds: ["old-balance", "ban"]
    });
    const all = extractCommentItems({ data: fixture.roots });
    fixture.author.readAllCommentSources = vi.fn(async () => all);
    fixture.author.commentOperations.deleteMany = vi.fn(async () => ({ deletedCommentIds: [] }));
    await fixture.author.deleteSupersededBalanceDirectives(latest.record, snapshot.record);
    const deletedSources = fixture.author.commentOperations.deleteMany.mock.calls.flatMap((call: any) => call[0].sources);
    expect(deletedSources.length).toBeGreaterThan(0);
    expect(deletedSources.every((source: any) => old.sources.some((s: any) => s.id === source.id)
      || ban.sources.some((s: any) => s.id === source.id))).toBe(true);
    expect(deletedSources.map((source: any) => source.id)).toContain(old.root.id);
    expect(fixture.author.commentOperations.deleteMany.mock.calls.every((call: any) => call[0].deleteRoots === true)).toBe(true);
    expect(deletedSources.some((source: any) => uncovered.sources.some((s: any) => s.id === source.id))).toBe(false);
    fixture.author.readAllCommentSources = vi.fn(async () => old.sources);
    await expect(fixture.author.deleteSupersededBalanceDirectives(latest.record, snapshot.record)).rejects.toThrow("旧指令已保留");
  });

  it("splits oversized comment cleanup by complete branches and deletes the root last", async () => {
    const deleteMany = vi.fn(async ({ sources, deleteRoots }: any) => ({
      commentIds: sources.map((source: any) => source.id),
      deletedCommentIds: sources.map((source: any) => source.id),
      alreadyMissingCommentIds: [],
      preservedRootCommentIds: [],
      fullyDeleted: true,
      deleteRoots
    }));
    const instance = service({
      getAccount: () => ({ accountId: "player" }),
      commentOperations: { publish: vi.fn(), deleteMany }
    });
    const root = { id: "root", account_id: "player" };
    const replies = Array.from({ length: 1002 }, (_, index) => ({
      id: `reply-${index}`, account_id: "player", parent_id: root.id
    }));
    const result = await instance.deleteCommentSources({
      workId: "work",
      sources: [root, ...replies],
      knownOwnedCommentIds: [root, ...replies].map(source => source.id),
      deleteRoots: true
    });
    expect(deleteMany).toHaveBeenCalledTimes(3);
    expect(deleteMany.mock.calls.map((call: any) => call[0].deleteRoots)).toEqual([false, false, true]);
    expect(deleteMany.mock.calls.at(-1)?.[0].sources).toEqual([root]);
    expect(result.deletedCommentIds).toHaveLength(1003);
  });

  it("accepts one signed additive daily red batch and persists its date through snapshots", async () => {
    const fixture = coverageHarness();
    const author = fixture.author;
    author.world.balance.dailyRedTime = "00:00";
    const batch = dailyRedTreasureBatch(author.world, fixture.base + 10_000);
    const record = signRecord({
      schema: "fyow.authority/1", authorityId: `red:${batch.day}`, gameId: author.world.gameId,
      workId: "work", seasonId: "season", authorityAccountId: "author",
      type: "daily-red-spawn", ...batch, issuedAt: fixture.base + 20
    }, fixture.identities.author.signingPrivateKey);
    const item = fixture.append(record, "author", fixture.base + 20);
    expect(author.applyAuthorityDirective(item)).toBe(true);
    expect(author.world.treasureSpawns.old).toBeDefined();
    expect(author.applyAuthorityDirective(item)).toBe(false);
    expect(author.world.dailyRedDates).toEqual([batch.day]);
    const duplicate = fixture.append(signRecord({ ...record, authorityId: "other-id" }, fixture.identities.author.signingPrivateKey), "author", fixture.base + 25);
    expect(author.applyAuthorityDirective(duplicate)).toBe(false);
    fixture.snapshot(author.world, 50, {
      version: 1, through: recordPlatformOrder(item), appliedAuthorityIds: [...author.appliedAuthorityIds]
    });
    const reader = fixture.create("player");
    await reader.sync(true);
    expect(reader.world.dailyRedDates).toEqual([batch.day]);
    expect(Object.keys(reader.world.treasureSpawns)).toHaveLength(1 + Object.keys(batch.treasureSpawns).length);
  });
  it("keeps an email-like platform username out of the game account projection", () => {
    const instance: any = service({
      getAccount: () => ({
        accountId: "account-12345678",
        username: "player@example.com",
        email: "player@example.com",
        token: "secret-token"
      })
    });
    expect(instance.account()).toEqual({
      accountId: "account-12345678",
      username: "玩家-12345678",
      displayName: "玩家-12345678",
      points: null
    });
    expect(instance.state().account).not.toHaveProperty("email");
    expect(instance.state().account).not.toHaveProperty("token");
  });

  it("preserves a real public nickname while ignoring a private email field", () => {
    const instance: any = service({
      getAccount: () => ({
        accountId: "account-1",
        username: "茂密",
        email: "private@example.com"
      })
    });
    expect(instance.account().username).toBe("茂密");
    expect(instance.state().account.username).toBe("茂密");
  });

  it("removes a seller-owned market general even when the cached listing id is missing", () => {
    const instance: any = service({ getAccount: () => ({ accountId: "seller" }) });
    instance.world = {
      players: { seller: { accountId: "seller", gold: 100, carriedGeneralIds: ["g-sale"] } },
      generals: { "g-sale": { id: "g-sale", holderAccountId: "seller", status: "carried", marketListingId: null } }
    };
    instance.marketSettledSales = new Set();
    expect(instance.applyMarketSaleToSeller({ transactionId: "tx-sale", listingId: "listing", generalId: "g-sale", sellerAccountId: "seller", price: 75 })).toBe(true);
    expect(instance.world.generals["g-sale"]).toBeUndefined();
    expect(instance.world.players.seller.carriedGeneralIds).toEqual([]);
    expect(instance.world.players.seller.gold).toBe(175);
    expect(instance.applyMarketSaleToSeller({ transactionId: "tx-sale", listingId: "listing", generalId: "g-sale", sellerAccountId: "seller", price: 75 })).toBe(false);
    expect(instance.world.players.seller.gold).toBe(175);
  });

  it("ignores model-supplied and edited experience when previewing a new general", () => {
    const forged = { ...completeGeneral, experience: 100, experienceRequired: 0, cultivationCount: 5 };
    const general = normalizeGeneratedGeneral(forged, { gender: "female" }, forged);
    expect(general).toMatchObject({ experience: 0, experienceRequired: 100, cultivationCount: 0 });
  });
  it("shares reads only within a cloud sync and reads new records on the next sync", async () => {
    const fixture = coverageHarness();
    const reader = fixture.create("player");
    const request = reader.requestConsole;
    const endpoints: string[] = [];
    reader.requestConsole = async (endpoint: string, options: any) => {
      endpoints.push(endpoint);
      return request(endpoint, options);
    };
    await reader.sync(true);
    expect(endpoints.filter(endpoint => endpoint.includes("?page=1&"))).toHaveLength(1);
    expect(reader.commentReadSession).toBeNull();
    fixture.map("player", 20, { cells: { "3,3": { ownerAccountId: "player", soldiers: 8, generalIds: [] } } });
    await reader.sync(true);
    expect(endpoints.filter(endpoint => endpoint.includes("?page=1&"))).toHaveLength(2);
    expect(reader.world.cells["3,3"].soldiers).toBe(8);
  });

  it("restarts an entry read if cloud page boundaries change and completes progress only after verification", async () => {
    const fixture = coverageHarness();
    const reader = fixture.create("player");
    reader.loadProgress = { schema: "fyow.load-progress/1", active: true, phase: "preparing", readComments: 0, totalComments: null };
    const events: any[] = [];
    reader.onChange = (state: any) => { if (state.loadProgress) events.push(state.loadProgress); };
    const request = reader.requestConsole;
    let firstPageReads = 0;
    reader.requestConsole = async (endpoint: string, options: any) => {
      if (endpoint.includes("?page=1&") && ++firstPageReads === 2) {
        fixture.map("player", 21, { cells: { "3,3": { ownerAccountId: "player", soldiers: 11, generalIds: [] } } });
      }
      return request(endpoint, options);
    };
    await reader.sync(true);
    expect(firstPageReads).toBe(4);
    expect(reader.world.cells["3,3"].soldiers).toBe(11);
    expect(events.some(event => event.phase === "validating" && event.active)).toBe(true);
    expect(reader.summary().loadProgress).toMatchObject({ active: false, phase: "complete" });
    expect(reader.loadProgress.readComments).toBe(reader.loadProgress.totalComments);
  });

  it("fails entry on a missing branch transport response without clearing the local archive", async () => {
    const fixture = coverageHarness();
    const pending = fixture.map("player", 25, { cells: {} }, { padding: crypto.randomBytes(3000).toString("hex") });
    pending.root.children = [];
    const reader = fixture.create("player");
    const request = reader.requestConsole;
    reader.requestConsole = async (endpoint: string, options: any) => {
      if (endpoint.startsWith("/comments/branches/")) throw new Error("503 missing branch");
      return request(endpoint, options);
    };
    reader.loadProgress = { active: true, phase: "reading", readComments: 0, totalComments: null };
    reader.world = structuredClone(fixture.author.world);
    reader.world.privatePlayers.player = { preserved: "private archive" };
    await expect(reader.sync(true)).rejects.toThrow(/分片读取中断/);
    expect(reader.world.privatePlayers.player.preserved).toBe("private archive");
    expect(reader.loadProgress.phase).toBe("error");
    expect(reader.commentReadSession).toBeNull();
  });

  it("reads signed control and state beyond short and empty interior pages using the platform total", async () => {
    const fixture = coverageHarness();
    fixture.map("player", 20, { cells: { "3,3": { ownerAccountId: "player", soldiers: 18, generalIds: [] } } });
    const records = fixture.roots.splice(0);
    const filler = Array.from({ length: 150 }, (_, index) => ({
      id: `filler-${index}`, content: "data", created_at: fixture.base + 1000 - index
    }));
    fixture.roots.push(...filler, ...records);
    const reader = fixture.create("player");
    reader.control = structuredClone(fixture.author.control);
    reader.world = structuredClone(fixture.author.world);
    reader.world.privatePlayers.player = { preserved: "local dialogue" };
    reader.historyTailPage = 1;
    reader.loadProgress = { active: true, phase: "reading", readComments: 0, totalComments: null };
    const requested: number[] = [];
    reader.requestConsole = async (endpoint: string) => {
      expect(endpoint).not.toContain("/branches/");
      const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
      requested.push(page);
      const roots = fixture.roots.slice((page - 1) * 50, page * 50);
      return { total: fixture.roots.length, data: page === 1 ? roots.slice(1) : page === 2 ? [] : roots };
    };
    await reader.sync(false);
    expect(reader.history.tailPage).toBe(4);
    expect(reader.control.id).toBe(fixture.author.control.id);
    expect(reader.world.cells["3,3"].soldiers).toBe(18);
    expect(reader.world.privatePlayers.player.preserved).toBe("local dialogue");
    expect(reader.loadProgress).toMatchObject({ active: false, phase: "complete" });
    expect(new Set(requested)).toEqual(new Set([1, 2, 3, 4, 5]));
    expect((await reader.readAllCommentSources()).some((item: any) => item.id === records[0].id)).toBe(true);
  });

  it("does not treat a short page as the end even when the platform omits its total", async () => {
    const fixture = coverageHarness();
    const reader = fixture.create("player");
    reader.requestConsole = async (endpoint: string) => {
      const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
      return { data: page === 1
        ? Array.from({ length: 49 }, (_, index) => ({ id: `short-${index}`, content: "data", created_at: fixture.base + 1000 - index }))
        : page === 2 ? fixture.roots : [] };
    };
    const history = await reader.readHistory(true);
    expect(history.tailPage).toBe(2);
    expect(reader.verifiedControls(history.assembled.records)).toHaveLength(1);
    expect(reader.verifiedSnapshots(history.assembled.records, fixture.author.control)).toHaveLength(1);
  });

  it("rechecks the page after a short tail during entry and retries if it has grown", async () => {
    const fixture = coverageHarness();
    const map = fixture.map("player", 20, { cells: { "3,3": { ownerAccountId: "player", soldiers: 19, generalIds: [] } } });
    fixture.roots.pop();
    const reader = fixture.create("player");
    reader.loadProgress = { active: true, phase: "reading", readComments: 0, totalComments: null };
    let nextPageReads = 0;
    reader.requestConsole = async (endpoint: string) => {
      const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
      return { data: page === 1 ? fixture.roots : page === 2 && ++nextPageReads >= 2 ? [map.root] : [] };
    };
    await reader.sync(true);
    expect(nextPageReads).toBeGreaterThanOrEqual(3);
    expect(reader.world.cells["3,3"].soldiers).toBe(19);
    expect(reader.history.tailPage).toBe(2);
    expect(reader.loadProgress.phase).toBe("complete");
  });

  it.each(["missing", "invalid-signature"])("still rejects %s cloud control instead of accepting cached control or clearing local data", async kind => {
    const fixture = coverageHarness();
    fixture.roots.shift();
    if (kind === "invalid-signature") fixture.append({ ...fixture.author.control, signature: "invalid" }, "author", fixture.base + 1);
    const reader = fixture.create("player");
    reader.control = structuredClone(fixture.author.control);
    reader.world = structuredClone(fixture.author.world);
    reader.world.privatePlayers.player = { preserved: "local dialogue" };
    reader.loadProgress = { active: true, phase: "reading", readComments: 0, totalComments: null };
    await expect(reader.sync(false)).rejects.toThrow("云端控制记录尚未读取完整");
    expect(reader.world.privatePlayers.player.preserved).toBe("local dialogue");
    expect(reader.control.id).toBe(fixture.author.control.id);
    expect(reader.loadProgress.phase).toBe("error");
  });

  it("rejects a platform that repeats the same roots on every page", async () => {
    const fixture = coverageHarness();
    const reader = fixture.create("player");
    reader.requestConsole = async () => ({ data: fixture.roots });
    await expect(reader.readHistory(true)).rejects.toMatchObject({ code: "FYOW_HISTORY_CHANGED" });
  });

  it("hydrates more than two hundred roots with at most four concurrent branch reads", async () => {
    const instance = service({});
    let active = 0;
    let maximum = 0;
    const roots: any[] = [];
    const replies = new Map();
    for (let index = 0; index < 205; index += 1) {
      const chunks = encodeCommentRecord({ schema: "fyow.event/3", eventId: `large-${index}`, padding: crypto.randomBytes(600).toString("hex") });
      expect(chunks.length).toBeGreaterThan(1);
      roots.push({ id: `root-${index}`, account_id: "author", content: chunks[0] });
      replies.set(`root-${index}`, chunks.slice(1).map((content: string, part: number) => ({ id: `reply-${index}-${part}`, account_id: "author", content, parent_id: `root-${index}` })));
    }
    instance.readCommentBranches = async (id: string) => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active -= 1;
      return replies.get(id);
    };
    const assembled = assembleCommentRecords(await instance.hydrateCommentReplies(roots));
    expect(assembled.records).toHaveLength(205);
    expect(assembled.incomplete).toHaveLength(0);
    expect(maximum).toBe(4);
  });

  it("keeps all three existing generals and dialogue after generating a fourth, then restoring the cache overlay", async () => {
    const { author: instance } = coverageHarness();
    instance.world.players.author = { accountId: "author", displayName: "yuoa333", position: { x: 16, y: 0 }, carriedGeneralIds: ["first", "second", "third"], fieldArmySoldiers: 0, gold: 100 };
    instance.world.privatePlayers.author = { orientation: "any", pendingGeneralDiscoveries: [{
      type: "general-generation-request", sourceKind: "neutral-battle", sourceId: "battle16",
      id: "neutral-battle:battle16", accountId: "author", x: 16, y: 0, gender: "female",
      initial: false, createdAt: instance.now()
    }], battleReports: [{ id: "battle16", jobId: "battle16", target: { x: 16, y: 0 }, discoveryId: "neutral-battle:battle16" }] };
    for (const id of ["first", "second", "third"]) {
      instance.world.generals[id] = createFallbackGeneral({ id, name: id, gender: "female", holderAccountId: "author", power: 300 });
    }
    instance.world.generals.first.interactionHistory = [{ userText: "以前的对话", reply: "保留原始回复", narration: "她点头。" }];
    const first = structuredClone(instance.world.generals.first);
    await instance.submitIntent({ type: "confirm-general-discovery", discoveryId: "neutral-battle:battle16", idempotencyKey: "fourth" });
    expect(Object.keys(instance.world.generals)).toHaveLength(4);
    expect(instance.world.generals.first).toEqual(first);
    expect(instance.world.players.author.carriedGeneralIds.slice(0, 3)).toEqual(["first", "second", "third"]);
    expect(instance.world.privatePlayers.author.battleReports[0].discoveredGeneralName).toBe("初将");
    const overlay = instance.captureLocalOverlay();
    const restarted = service({ getAccount: () => ({ accountId: "author" }) });
    restarted.world = require("../electron/grid-world-game.cjs").projectWorldState(instance.world, "");
    restarted.restoreLocalOverlay(JSON.parse(JSON.stringify(overlay)));
    delete restarted.world.players.author.carriedGeneralIds;
    restarted.recoverOwnLocalPlayerState();
    expect(restarted.world.players.author.carriedGeneralIds).toHaveLength(4);
    expect(restarted.world.generals.first.interactionHistory).toEqual(first.interactionHistory);
    await instance.submitIntent({ type: "confirm-general-discovery", discoveryId: "neutral-battle:battle16", idempotencyKey: "fourth" });
    expect(Object.keys(instance.world.generals)).toHaveLength(4);
  });

  it("relocates a player from a lost position to the nearest owned territory without rebuilding gold", () => {
    const instance = service({ getAccount: () => ({ accountId: "player", username: "玩家" }) });
    instance.world = createWorld({ seed: "relocation", seasonId: "season", authorityAccountId: "authority" });
    instance.world.players.player = {
      accountId: "player", displayName: "玩家", gold: 777, basePower: 100, power: 100, trainingLevel: 0,
      position: { x: 10, y: 10 }, retreatPath: [{ x: 10, y: 10 }, { x: 9, y: 10 }], fieldArmySoldiers: 0, carriedGeneralIds: []
    };
    instance.world.cells["10,10"] = { ownerAccountId: "enemy", soldiers: 1, generalIds: [] };
    instance.world.cells["9,10"] = { ownerAccountId: "player", soldiers: 1, generalIds: [] };
    instance.world.cells["20,20"] = { ownerAccountId: "player", soldiers: 1, generalIds: [] };

    expect(instance.recoverOwnLocalPlayerState()).toBe(true);
    expect(instance.world.players.player.position).toEqual({ x: 9, y: 10 });
    expect(instance.world.players.player.retreatPath).toBeUndefined();
    expect(instance.world.players.player.gold).toBe(777);
  });

  it("publishes one atomic recovery record when the current player has lost every territory", async () => {
    const { author: instance, create, base } = coverageHarness();
    instance.world.players.author = {
      accountId: "author", displayName: "服主", accountName: "author", gold: 500, basePower: 100, power: 100,
      trainingLevel: 0, position: { x: 10, y: 10 }, fieldArmySoldiers: 0, carriedGeneralIds: ["g1", "g2"]
    };
    instance.world.privatePlayers.author = { defeatRecoveryCount: 0 };
    instance.world.cells["10,10"] = { ownerAccountId: "player", soldiers: 1, generalIds: [], occupationCount: 1 };
    instance.world.generals.g1 = createFallbackGeneral({ id: "g1", name: "甲一", holderAccountId: "author", power: 200 });
    instance.world.generals.g2 = createFallbackGeneral({ id: "g2", name: "甲二", holderAccountId: "author", power: 300 });
    const beforeRecovery = structuredClone(instance.world);
    let published: any = null;
    const publish = instance.publishMapChanges.bind(instance);
    instance.publishMapChanges = async (...args: any[]) => { published = await publish(...args); return published; };

    expect(await instance.ensureOwnPlayerAccessAfterSync()).toBe(true);
    expect(published).toBeTruthy();
    expect(Object.keys(published.changes.cells)).toHaveLength(1);
    expect(Object.keys(published.changes.marketListings)).toHaveLength(2);
    expect(instance.world.players.author.carriedGeneralIds).toEqual([]);
    expect(Object.values(instance.world.marketListings)).toHaveLength(2);
    expect(instance.pendingIntentTransaction).toBeNull();
    const observer = create("player");
    observer.control = instance.control;
    observer.world = beforeRecovery;
    const recoveryItem = { record: published, sources: [{ id: "recovery-comment", account_id: "author", created_at: base + 20_000 }] };
    expect(observer.validMapDelta(recoveryItem)).toBe(true);
    expect(observer.applyMapDelta(recoveryItem)).toBe(true);
    expect(Object.values(observer.world.marketListings)).toHaveLength(2);
    expect(Object.values(observer.world.cells).filter((cell: any) => cell.ownerAccountId === "author")).toHaveLength(1);
    expect(await instance.ensureOwnPlayerAccessAfterSync()).toBe(false);
  });

  it("does not delete a recalled private general when an old capture tombstone arrives", () => {
    const { author: instance, map, base } = coverageHarness();
    instance.world.players.author = { accountId: "author", position: { x: 16, y: 0 }, carriedGeneralIds: ["first"] };
    instance.world.generals.first = createFallbackGeneral({ id: "first", name: "初将", holderAccountId: "author", power: 300 });
    const original = structuredClone(instance.world.generals.first);
    const stale = map("player", 100, {
      cells: { "2,2": { ownerAccountId: "player", soldiers: 1, generalIds: [] } }, generals: { first: null },
      generalTransitions: { first: { generalId: "first", holderAccountId: "author", from: { x: 2, y: 2 }, targetStatus: "captured", nextHolderAccountId: "player", reason: "captured" } }
    });
    expect(instance.applyMapDelta(stale)).toBe(true);
    expect(instance.world.generals.first).toEqual(original);
    expect(instance.world.players.author.carriedGeneralIds).toEqual(["first"]);

    instance.world.generals.first.status = "deployed";
    instance.world.generals.first.location = { x: 2, y: 2 };
    instance.world.cells["2,2"] = { ownerAccountId: "author", soldiers: 2, generalIds: ["first"] };
    instance.publicCellOrders["2,2"] = { timestamp: base + 1000, commentId: "new-deployment" };
    const staleSecond = map("player", 200, stale.record.changes);
    expect(instance.applyMapDelta(staleSecond)).toBe(true);
    expect(instance.world.generals.first.status).toBe("deployed");
    expect(instance.world.cells["2,2"].generalIds).toEqual(["first"]);
  });

  it("publishes loss reports with captive names, retains them in snapshots, and never resurrects dismissed reports", async () => {
    const { author: attacker, create, identities, base } = coverageHarness();
    attacker.world.players.author = { accountId: "author", displayName: "攻方角色", accountName: "attacker@example", position: { x: 1, y: 1 }, carriedGeneralIds: [], fieldArmySoldiers: 0, gold: 100 };
    attacker.world.players.player = { accountId: "player", displayName: "守方" };
    attacker.world.privatePlayers.author = { orientation: "any" };
    attacker.world.cells["2,1"] = { ownerAccountId: "player", soldiers: 100, generalIds: ["guard"] };
    attacker.world.generals.guard = createFallbackGeneral({ id: "guard", name: "守地将领", holderAccountId: "player", power: 300 });
    Object.assign(attacker.world.generals.guard, { status: "deployed", location: { x: 2, y: 1 } });
    attacker.world.treasureSpawns.pill = { id: "pill", epoch: 1, materialId: "gold", x: 2, y: 1, spawnedAt: base };
    const defender = create("player");
    defender.control = attacker.control;
    defender.world = structuredClone(attacker.world);
    defender.world.privatePlayers = { player: { battleReports: [{ id: "own-attack", kind: "attack", outcome: "victory", target: { x: 9, y: 9 }, createdAt: base }] } };
    attacker.world.jobs.conquest = { id: "conquest", type: "march", accountId: "author", from: { x: 1, y: 1 }, to: { x: 2, y: 1 }, generalIds: [], activeGeneralIds: [], soldiers: 20000, attack: true, startedAt: base, finishAt: base + 1000 };
    let posted: any;
    const publish = attacker.publishMapChanges.bind(attacker);
    attacker.publishMapChanges = async (...args: any[]) => { posted = await publish(...args); return posted; };
    await attacker.settleLocalClock();
    expect(attacker.world.privatePlayers.author.battleReports[0].treasures).toEqual([{ treasureId: "pill", materialId: "gold", amount: 1 }]);
    expect(attacker.world.privatePlayers.author.materials.gold).toBe(1);
    const item = { record: posted, sources: [{ id: "conquest-comment", account_id: "author", created_at: base + 500 }] };
    expect(defender.validMapDelta(item)).toBe(true);
    expect(defender.applyMapDelta(item)).toBe(true);
    const reports = defender.world.privatePlayers.player.battleReports;
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ kind: "territory-loss", target: { x: 2, y: 1 }, attackerDisplayName: "攻方角色", attackerAccountName: "attacker@example", capturedOwnGenerals: [{ id: "guard", name: "守地将领" }], ownLosses: 100 });
    expect(defender.world.generals.guard).toBeUndefined();
    const snapshot = require("../electron/grid-world-game.cjs").projectWorldState(attacker.world, "");
    const offline = create("player");
    offline.world = structuredClone(snapshot);
    offline.reconcileConquestReports();
    expect(offline.world.privatePlayers.player.battleReports[0]).toMatchObject({ kind: "territory-loss", capturedOwnGenerals: [{ id: "guard", name: "守地将领" }] });
    const summary = require("../electron/grid-world-game.cjs").battleReportSummary(reports[1]);
    expect(summary).toContain("领地被攻方角色攻占");
    expect(summary).toContain("我方被俘将领：守地将领");
    defender.world.privatePlayers.player.battleReports = [];
    const overlay = defender.captureLocalOverlay();
    defender.world = structuredClone(snapshot);
    defender.restoreLocalOverlay(overlay);
    defender.reconcileConquestReports();
    expect(defender.world.privatePlayers.player.battleReports).toEqual([]);
    offline.world.playerEpochs.player = 1;
    offline.world.privatePlayers.player = {};
    offline.reconcileConquestReports();
    expect(offline.world.privatePlayers.player.battleReports).toBeUndefined();
    const forged = structuredClone(posted);
    forged.changes.conquests.conquest.defenderLosses = 0;
    expect(defender.validMapDelta({ ...item, record: signRecord(forged, identities.author.signingPrivateKey) })).toBe(false);
  });

  it("confirms a compacted pending treasure without losing or duplicating the local reward", () => {
    const { author: instance, base } = coverageHarness();
    instance.world.privatePlayers.author = { materials: { white: 0 }, treasureClaimRewards: {
      old: { materialId: "white", amount: 1, status: "pending", credited: false, playerEpoch: 0 }
    } };
    instance.world.claimedTreasures.old = { treasureId: "old", materialId: "white", accountId: "author", epoch: 1, x: 1, y: 1, platformOrder: { timestamp: base + 50, commentId: "claim" } };
    instance.publicMapBaselineOrder = { timestamp: base + 100, commentId: "covered" };
    const history = { confirmationComplete: true, assembled: { records: [], incomplete: [] } };
    instance.reconcileTreasureRewards(history);
    expect(instance.world.privatePlayers.author.materials.white).toBe(1);
    instance.world.privatePlayers.author.materials.white = 0;
    const overlay = instance.captureLocalOverlay();
    instance.world = require("../electron/grid-world-game.cjs").projectWorldState(instance.world, "");
    instance.restoreLocalOverlay(overlay);
    instance.reconcileTreasureRewards(history);
    expect(instance.world.privatePlayers.author.materials.white).toBe(0);
    expect(instance.world.privatePlayers.author.treasureClaimRewards.old.status).toBe("confirmed");
  });

  it("persists updated local preferences into the active player state", async () => {
    const saveCache = vi.fn();
    const instance = service({ getAccount: () => ({ accountId: "player" }) });
    instance.control = { id: "control" };
    instance.world = createWorld({ seed: "preferences", seasonId: "season", authorityAccountId: "author", startedAt: 1 });
    instance.world.players.player = { accountId: "player", displayName: "玩家", carriedGeneralIds: [] };
    instance.world.privatePlayers.player = {};
    instance.saveCache = saveCache;
    try {
      const state = await instance.updateLocalPreferences({
        orientation: "women",
        characterTags: [{ tag: "狐耳", note: "蓬松" }, { tag: "高挑", note: "" }]
      });
      expect(state.localPreferences).toEqual({
        orientation: "women",
        characterProfileId: "",
        characterTags: ["狐耳｜蓬松", "高挑"]
      });
      expect(instance.world.privatePlayers.player).toMatchObject({
        orientation: "women",
        characterTags: ["狐耳｜蓬松", "高挑"]
      });
      expect(saveCache).toHaveBeenCalledOnce();
    } finally { instance.close(); }
  });

  it("backs off polling after transport failures instead of retrying every five seconds", async () => {
    vi.useFakeTimers();
    const instance = service({});
    instance.sync = vi.fn(async () => { throw new Error("Failed to fetch"); });
    try {
      instance.startPolling();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(instance.sync).toHaveBeenCalledTimes(1);
      expect(instance.pollFailureCount).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(instance.sync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(instance.sync).toHaveBeenCalledTimes(2);
    } finally {
      instance.close();
      vi.useRealTimers();
    }
  });

  it("stops comment reads at the next await boundary when returning to the library", async () => {
    vi.useFakeTimers();
    let release!: (value: any) => void;
    let reads = 0;
    const instance = service({
      requestConsole: async () => { reads += 1; return new Promise(resolve => { release = resolve; }); }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    try {
      instance.startPolling();
      const syncing = instance.sync(true);
      await vi.waitFor(() => expect(reads).toBe(1));
      const paused = instance.pause();
      release({ data: Array.from({ length: 50 }, (_, index) => ({ id: `comment-${index}`, content: "普通评论" })) });
      await Promise.all([syncing, paused]);
      expect(instance.pollTimer).toBeNull();
      expect(instance.status).toBe("closed");
      await vi.advanceTimersByTimeAsync(60000);
      await instance.sync(true);
      expect(reads).toBe(1);
      expect(instance.error).toBeNull();
    } finally {
      instance.close();
      vi.useRealTimers();
    }
  });

  it("refreshes current data and resumes polling only on explicitly reentering a game", async () => {
    const card = createBundledGridCard();
    let reads = 0;
    const instance = service({
      getAccount: () => ({ accountId: card.companion.authorAccountId }),
      requestConsole: async (endpoint: string) => {
        reads += 1;
        return endpoint.startsWith("/installed-apps/")
          ? { id: card.companion.workId, created_by_account_id: card.companion.authorAccountId }
          : { data: [] };
      }
    });
    try {
      await instance.open({ card });
      expect(instance.pollTimer).not.toBeNull();
      await instance.pause();
      const before = reads;
      await instance.sync(true);
      expect(reads).toBe(before);
      await instance.open({ card });
      expect(reads).toBeGreaterThan(before);
      expect(instance.syncPaused).toBe(false);
      expect(instance.pollTimer).not.toBeNull();
    } finally { instance.close(); }
  });

  it("verifies the selected card's platform author and exports that card without opening or polling it", async () => {
    const activeCard = createBundledGridCard();
    const selectedCard = rebindGameCard(activeCard, "second-work-123");
    const endpoints: string[] = [];
    const instance = service({
      getAccount: () => ({ accountId: activeCard.companion.authorAccountId }),
      requestConsole: async (endpoint: string) => {
        endpoints.push(endpoint);
        return endpoint.startsWith("/installed-apps/")
          ? { id: selectedCard.companion.workId, created_by_account_id: selectedCard.companion.authorAccountId }
          : selectedCard.companion.configuration;
      }
    });
    instance.card = activeCard;
    instance.work = { id: activeCard.companion.workId, authorAccountId: activeCard.companion.authorAccountId };
    await instance.pause();
    const exported = await instance.exportGameCard(selectedCard);
    expect(exported.companion.workId).toBe("second-work-123");
    expect(endpoints).toEqual(["/installed-apps/second-work-123", "/apps/second-work-123/model-config/export"]);
    expect(instance.work.id).toBe(activeCard.companion.workId);
    expect(instance.card).toBe(activeCard);
    expect(instance.pollTimer).toBeNull();
    expect(instance.status).toBe("closed");
    instance.requestConsole = async () => ({ id: selectedCard.companion.workId, created_by_account_id: "other" });
    expect(await instance.isGameCardAuthor(selectedCard)).toBe(false);
    await expect(instance.exportGameCard(selectedCard)).rejects.toThrow(/只有伴生作品作者/);
  });

  it("uploads the local game-card configuration and world books after rechecking the platform author", async () => {
    const card = createBundledGridCard();
    const endpoints: string[] = [];
    let saved: any = null;
    const instance = service({
      getAccount: () => ({ accountId: card.companion.authorAccountId }),
      requestConsole: async (endpoint: string, options: any = {}) => {
        endpoints.push(`${options.method || "GET"} ${endpoint}`);
        if (endpoint.startsWith("/installed-apps/")) {
          return { id: card.companion.workId, created_by_account_id: card.companion.authorAccountId };
        }
        if (endpoint.endsWith("/model-config") && options.method === "POST") {
          saved = options.body;
          return { ok: true };
        }
        if (endpoint.endsWith("/model-config/export")) return { data: saved };
        throw new Error(`unexpected ${endpoint}`);
      }
    });
    const updated = await instance.updateGameCardCloud(card);
    expect(saved).toMatchObject({
      pre_prompt: card.companion.configuration.pre_prompt,
      pre_text: card.companion.configuration.pre_text,
      post_text: card.companion.configuration.post_text,
      app: {
        name: card.companion.configuration.app.name,
        description: card.companion.configuration.app.description
      }
    });
    expect(saved.world_book).toEqual(card.companion.configuration.world_book);
    expect(updated.companion.configuration.world_book).toEqual(card.companion.configuration.world_book);
    expect(updated.program.digest).toBe(card.program.digest);
    expect(endpoints).toEqual([
      `GET /installed-apps/${card.companion.workId}`,
      `POST /apps/${card.companion.workId}/model-config`,
      `GET /apps/${card.companion.workId}/model-config/export`
    ]);
  });

  it("rejects a cloud configuration update when the platform author does not match the card", async () => {
    const card = createBundledGridCard();
    let writes = 0;
    const instance = service({
      getAccount: () => ({ accountId: card.companion.authorAccountId }),
      requestConsole: async (_endpoint: string, options: any = {}) => {
        if (options.method === "POST") writes += 1;
        return { id: card.companion.workId, created_by_account_id: "different-author" };
      }
    });
    await expect(instance.updateGameCardCloud(card)).rejects.toThrow(/只有伴生作品作者/);
    expect(writes).toBe(0);
  });

  it("repairs legacy snapshots that omitted the season authority binding for guests", () => {
    const legacy = createWorld({ authorityAccountId: "author" });
    delete legacy.authorityAccountId;
    expect(bindWorldAuthority(legacy, { authorityAccountId: "author" })).toBe(legacy);
    expect(legacy.authorityAccountId).toBe("author");
    expect(() => bindWorldAuthority({ authorityAccountId: "other" }, { authorityAccountId: "author" })).toThrow(/权威绑定/);
  });
  it("rejects placeholder profile text but accepts any structured general length and model power", () => {
    expect(playerContextQualityIssue({
      personaSummary: "名为茂密的猫亚人，除此之外玩家未提供更多信息。".repeat(6),
      appearanceSummary: completeAppearance,
      speechStyle: completeSpeech,
      relationshipApproach: completeRelationship
    })).toMatch(/占位措辞/);
    expect(playerContextQualityIssue({ personaSummary: completePersona, appearanceSummary: completeAppearance, speechStyle: completeSpeech, relationshipApproach: completeRelationship })).toBeNull();
    expect(generalGenerationQualityIssue({ ...completeGeneral, coreSetting: "善战。", power: "任意" }, { gender: "female" })).toBeNull();
    expect(generalGenerationQualityIssue(completeGeneral, { gender: "female" })).toBeNull();
    expect(normalizeGeneratedGeneral({ ...completeGeneral, coreSetting: "善战。", power: 999999 }, { gender: "female" })).toMatchObject({ coreSetting: "善战。", power: 150 });
    const seededPower = normalizeGeneratedGeneral(completeGeneral, {
      gender: "female", generatedSeed: "season-seed", accountId: "player", sourceId: "discovery"
    }).power;
    expect(seededPower).toBe(generatedGeneralPower("season-seed", "player", "discovery"));
    expect(seededPower).toBeGreaterThanOrEqual(125);
    expect(seededPower).toBeLessThanOrEqual(175);
    const generatedWorld = createWorld({ seed: "season-seed", seasonId: "season", startedAt: 1, authorityAccountId: "player" });
    generatedWorld.players.player = { accountId: "player", displayName: "玩家", gold: 500, position: { x: 2, y: 2 }, carriedGeneralIds: [] };
    generatedWorld.privatePlayers.player = { orientation: "any", materials: {} };
    const committed = require("../electron/grid-world-game.cjs").applyIntent(generatedWorld, {
      type: "grant-general", generalId: "generated", name: "初将", gender: "female", coreSetting: "善战。",
      power: 999999, generated: true, powerSeed: "discovery", discoveryId: "discovery", idempotencyKey: "grant-generated"
    }, { actorAccountId: "player", authorityAccountId: "player", now: 2 });
    expect(committed.state.generals.generated.power).toBe(seededPower);
    expect(normalizeGeneratedGeneral({ personaSummary: "名为“茂密”的猫亚人，善于领兵。", appearanceSummary: "白发猫耳。" }, { gender: "female" })).toMatchObject({ name: "茂密", appearanceSetting: "白发猫耳。", coreSetting: expect.stringContaining("善于领兵"), power: 150 });
    expect(normalizeGeneratedGeneral({ ...completeGeneral, coreSetting: "长设定".repeat(1200) }, { gender: "female" }).coreSetting.length).toBeGreaterThan(800);
  });

  it("validates every dialogue command and completed long-term memory before applying it", () => {
    expect(compactDialogueReply("愿与主公详谈。")).toBe("愿与主公详谈。");
    expect(Array.from(compactDialogueReply("北境尚有战事。".repeat(30))).length).toBeLessThanOrEqual(180);
    expect(compactDialogueReply("战局未定，".repeat(50))).toMatch(/…$/);
    expect(dialogueQualityIssue({ reply: "愿与主公详谈。", command: null }, { captive: false })).toBeNull();
    expect(dialogueQualityIssue({ reply: "我愿降服。", command: { type: "surrender" } }, { captive: false })).toMatch(/普通将领/);
    expect(dialogueQualityIssue({ reply: "请代我传信。", command: { type: "send-letter", recipientKey: "former-lord-2", text: "一切安好。" } }, { allowedRecipientKeys: ["former-lord-1"] })).toMatch(/历任主公名单/);
    expect(generalMemoryQualityIssue({ category: "speech", summary: "谈论北境", emotion: "振奋", intimacyDelta: 2, compactMemory: "言谈：[1年]谈论北境\n经历：[1年]被提拔为将领" })).toBeNull();
    expect(generalMemoryQualityIssue({ category: "speech", summary: "谈论北境", emotion: "振奋", intimacyDelta: 2, compactMemory: "只有言谈" })).toMatch(/同时包含言谈和经历/);
  });

  it("finds the real newest page and conservatively scans legacy snapshots without coverage metadata", async () => {
    const oldControl = { schema: "fyow.control/3", id: "old", seasonId: "season", programHash: "old" };
    const latestControl = { schema: "fyow.control/3", id: "latest", seasonId: "season", programHash: "latest" };
    const snapshot = { schema: "fyow.snapshot/3", snapshotId: "snapshot", seasonId: "season", revision: 20, stateHash: "hash" };
    const comment = (id: string, content: string, second: number) => ({ id, content, created_at: second });
    const page1 = [
      ...encodeCommentRecord(oldControl).map((content: string, index: number) => comment(`old-control-${index}`, content, 1)),
      ...Array.from({ length: 49 }, (_, index) => comment(`old-${index}`, "旧评论", 2 + index))
    ].slice(0, 50);
    const page2 = [
      ...encodeCommentRecord(snapshot).map((content: string, index: number) => comment(`snapshot-${index}`, content, 100)),
      ...Array.from({ length: 49 }, (_, index) => comment(`middle-${index}`, "中间评论", 101 + index))
    ].slice(0, 50);
    const page3 = encodeCommentRecord(latestControl).map((content: string, index: number) => comment(`latest-control-${index}`, content, 200));
    page3.push(comment("latest-ordinary", "最新评论", 201));
    const requested: number[] = [];
    const instance = service({
      requestConsole: async (endpoint: string) => {
        const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
        requested.push(page);
        return page === 1 ? page1 : page === 2 ? page2 : page === 3 ? page3 : [];
      }
    });
    instance.work = { id: "work" };
    const history = await instance.readHistory(true);
    expect(history.assembled.records.map((item: any) => item.record.id).filter(Boolean)).toContain("latest");
    expect(history.assembled.records.map((item: any) => item.record.id).filter(Boolean)).toContain("old");
    expect(instance.history).toMatchObject({ tailPage: 3, stoppedBy: "oldest-page" });
    expect([...new Set(requested)]).toEqual([1, 2, 3, 5, 4]);

    requested.splice(0);
    instance.publicHistoryOrder = history.completeThrough;
    instance.knownCommentIds.add("latest-ordinary");
    await instance.readHistory(false);
    expect(requested).toEqual([1, 3, 4]);
    expect(instance.history.stoppedBy).toBe("known-comment-reached");
  });

  it("keeps scanning from the newest edge if the platform starts honoring descending order", async () => {
    const oldControl = { schema: "fyow.control/3", id: "old-desc", seasonId: "season", programHash: "old" };
    const latestControl = { schema: "fyow.control/3", id: "latest-desc", seasonId: "season", programHash: "latest" };
    const snapshot = { schema: "fyow.snapshot/3", snapshotId: "snapshot-desc", seasonId: "season", revision: 20, stateHash: "hash" };
    const comment = (id: string, content: string, second: number) => ({ id, content, created_at: second });
    const page1 = [
      ...encodeCommentRecord(latestControl).map((content: string, index: number) => comment(`latest-desc-${index}`, content, 300)),
      ...Array.from({ length: 49 }, (_, index) => comment(`new-${index}`, "新评论", 250 - index))
    ].slice(0, 50);
    const page2 = [
      ...encodeCommentRecord(snapshot).map((content: string, index: number) => comment(`snapshot-desc-${index}`, content, 150)),
      ...Array.from({ length: 49 }, (_, index) => comment(`middle-desc-${index}`, "中间评论", 149 - index))
    ].slice(0, 50);
    const page3 = encodeCommentRecord(oldControl).map((content: string, index: number) => comment(`old-desc-${index}`, content, 1));
    const instance = service({
      requestConsole: async (endpoint: string) => {
        const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
        return page === 1 ? page1 : page === 2 ? page2 : page === 3 ? page3 : [];
      }
    });
    instance.work = { id: "work" };
    const history = await instance.readHistory(true);
    const ids = history.assembled.records.map((item: any) => item.record.id).filter(Boolean);
    expect(ids).toContain("latest-desc");
    expect(ids).toContain("old-desc");
    expect(instance.history).toMatchObject({ tailPage: 3, pageOrder: "newest-first", stoppedBy: "oldest-page" });
  });

  it("reads every page when comments are relevance-ranked instead of chronological", async () => {
    const oldControl = { schema: "fyow.control/3", id: "old-ranked", seasonId: "season", programHash: "old" };
    const latestControl = { schema: "fyow.control/3", id: "latest-ranked", seasonId: "season", programHash: "latest" };
    const snapshot = { schema: "fyow.snapshot/3", snapshotId: "ranked-snapshot", seasonId: "season", revision: 30, stateHash: "hash" };
    const comment = (id: string, content: string, second: number) => ({ id, content, created_at: second });
    const page1 = [
      ...encodeCommentRecord(oldControl).map((content: string, index: number) => comment(`ranked-old-${index}`, content, 200)),
      ...encodeCommentRecord(snapshot).map((content: string, index: number) => comment(`ranked-snapshot-${index}`, content, 190)),
      ...Array.from({ length: 48 }, (_, index) => comment(`ranked-filler-1-${index}`, "旧评论", 100 + index))
    ].slice(0, 50);
    const page2 = [
      ...encodeCommentRecord(latestControl).map((content: string, index: number) => comment(`ranked-latest-${index}`, content, 300)),
      ...Array.from({ length: 49 }, (_, index) => comment(`ranked-filler-2-${index}`, "评论", 60 + index))
    ].slice(0, 50);
    const page3 = Array.from({ length: 17 }, (_, index) => comment(`ranked-filler-3-${index}`, "更早评论", 50 + index));
    const requested: number[] = [];
    const instance = service({ requestConsole: async (endpoint: string) => {
      const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
      requested.push(page);
      return page === 1 ? page1 : page === 2 ? page2 : page === 3 ? page3 : [];
    } });
    instance.work = { id: "work" };
    const history = await instance.readHistory(true);
    expect(history.assembled.records.map((item: any) => item.record.id)).toContain("latest-ranked");
    expect(instance.history).toMatchObject({ tailPage: 3, pageOrder: "mixed", stoppedBy: "mixed-page-order-full-scan" });
    expect([...new Set(requested)].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("replaces a legacy player's generated context with the bound profile facts", async () => {
    const instance = service({ getAccount: () => ({ accountId: "author", username: "服主" }) });
    instance.world = createWorld({ seed: "legacy", seasonId: "season", startedAt: 1_000_000, authorityAccountId: "author" });
    instance.world.players.author = { accountId: "author", displayName: "茂密", gold: 1000, position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [], joinedAt: 1_000_000 };
    instance.world.privatePlayers.author = { playerContext: { personaSummary: "未提供", appearanceSummary: "暂无", speechStyle: "未知", relationshipApproach: "待补充" } };
    instance.localPreferences.characterProfile = { id: "profile", displayName: "茂密", basicInfo: "猫亚人", appearance: "白色头发", info: "猫亚人，白色头发" };
    instance.localPreferences.playerContext = null;
    const repaired = await instance.ensureLocalPlayerContext();
    expect(repaired).toEqual(playerContextFromProfile(instance.localPreferences.characterProfile));
    expect(repaired).toMatchObject({ displayName: "茂密", personaSummary: "猫亚人", appearanceSummary: "白色头发" });
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
        return { conversationId: `conversation-queue-${calls.length}`, answer: JSON.stringify({ task: request.task }), points: { total: calls.length }, remainingPoints: String(100 - calls.length) };
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
    expect(instance.state().modelUsageEvents).toMatchObject([
      { id: 1, task: "first", label: "模型请求", points: { total: 1 }, remainingPoints: "99" },
      { id: 2, task: "second", label: "模型请求", points: { total: 2 }, remainingPoints: "98" }
    ]);
  });

  it("rejects a platform response that reuses an earlier model conversation", async () => {
    const instance = service({
      requestModel: async (request: any) => ({ conversationId: "reused-conversation", answer: JSON.stringify({ task: request.task }) })
    });
    await expect(instance.requestStructuredModel({ task: "first" }, { attempts: 1 })).resolves.toEqual({ task: "first" });
    await expect(instance.requestStructuredModel({ task: "second" }, { attempts: 1 })).rejects.toThrow(/复用了已经使用过的模型会话/);
  });

  it("retries transient comment writes without changing the encoded record", async () => {
    let attempts = 0;
    const posted: string[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      requestConsole: async (_endpoint: string, options: any = {}) => {
        attempts += 1;
        posted.push(options.body.content);
        if (attempts < 3) throw new Error("temporary comment failure");
        return { id: "comment-ok", account_id: "author" };
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    const result = await instance.postRecord({ schema: "fyow.event/3", eventId: "retry-event", gameId: "game", workId: "work", seasonId: "season" });
    expect(attempts).toBe(3);
    expect(new Set(posted).size).toBe(1);
    expect(result[0].id).toBe("comment-ok");
  });

  it("stores long records as one root with native continuation replies and a 980-character hard cap", async () => {
    const posted: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      requestConsole: async (_endpoint: string, options: any = {}) => {
        posted.push(options.body);
        return { id: `chunk-${posted.length}`, account_id: "author", created_at: 100 + posted.length, content: options.body.content };
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    const record = { schema: "fyow.snapshot/3", snapshotId: "native-root", state: { archive: crypto.randomBytes(4500).toString("hex") } };
    const sources = await instance.postRecord(record);
    expect(posted.length).toBeGreaterThan(3);
    expect(posted[0].parent_id).toBeUndefined();
    expect(posted.slice(1).every(body => body.parent_id === "chunk-1" && body.to_account_id === "author")).toBe(true);
    expect(posted.every(body => body.content.length <= 980)).toBe(true);
    expect(assembleCommentRecords(sources).records[0].record).toEqual(record);
    expect(recordPlatformOrder({ sources }).timestamp).toBe(101_000);
    await expect(instance.postComment("x".repeat(981))).rejects.toThrow(/980/);
    expect(posted).toHaveLength(sources.length);
  });

  it("recovers long native reply records across reply pagination before applying the root", async () => {
    const record = { schema: "fyow.snapshot/3", snapshotId: "paginated-replies", revision: 4, state: { archive: crypto.randomBytes(30_000).toString("hex") } };
    const chunks = encodeCommentRecord(record);
    expect(chunks.length).toBeGreaterThan(50);
    const root = { id: "root", account_id: "author", content: chunks[0], created_at: 100 };
    const replies = chunks.slice(1).map((content: string, index: number) => ({
      id: `reply-${index}`, account_id: "author", parent_id: "root", content, created_at: 200 + index
    }));
    const endpoints: string[] = [];
    const instance = service({
      requestConsole: async (endpoint: string) => {
        endpoints.push(endpoint);
        if (endpoint === "/comments/branches/root") return { data: replies.slice(0, 50), has_more: true };
        if (endpoint === "/comments/branches/root?page=2&limit=50") return { data: replies.slice(50), has_more: false };
        return [];
      }
    });
    const comments = await instance.hydrateCommentReplies([root]);
    const assembled = assembleCommentRecords(comments);
    expect(assembled.records[0].record).toEqual(record);
    expect(recordPlatformOrder(assembled.records[0])).toEqual({ timestamp: 100_000, commentId: "root" });
    expect(endpoints).toEqual(["/comments/branches/root", "/comments/branches/root?page=2&limit=50"]);
  });

  it("registers the first map fragment as the letter entry point instead of sorting reply IDs", async () => {
    const identity = generateOnlineWorldIdentity();
    const sources: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      requestConsole: async (_endpoint: string, options: any = {}) => {
        const item = {
          id: sources.length ? `a-reply-${sources.length}` : "z-root", account_id: "player",
          created_at: 100 + sources.length, content: options.body.content, parent_id: options.body.parent_id
        };
        sources.push(item);
        return item;
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    await instance.publishMapChanges({
      cells: {},
      generals: { "large-general": { coreSetting: crypto.randomBytes(1800).toString("hex") } }
    }, identity);
    expect(sources.length).toBeGreaterThan(1);
    expect(instance.world.players.player.commentRootId).toBe("z-root");
  });

  it("counts only root comments for history pagination when one root embeds over fifty native replies", async () => {
    const record = { schema: "fyow.snapshot/3", snapshotId: "large-child-page", revision: 4, state: { archive: crypto.randomBytes(30_000).toString("hex") } };
    const chunks = encodeCommentRecord(record);
    expect(chunks.length).toBeGreaterThan(50);
    const root = {
      id: "root", account_id: "author", content: chunks[0], created_at: 200,
      children: chunks.slice(1).map((content: string, index: number) => ({
        id: `reply-${index}`, account_id: "author", content, created_at: index % 2 ? 900_000 : 800_000
      }))
    };
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `ordinary-${index}`, account_id: "author", content: "普通评论", created_at: 100 + index
    }));
    const endpoints: string[] = [];
    const instance = service({
      requestConsole: async (endpoint: string) => {
        endpoints.push(endpoint);
        if (endpoint.includes("/branches/")) throw new Error("complete embedded replies need no branch read");
        const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
        return { data: page === 1 ? firstPage : page === 2 ? [root] : [] };
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season" };
    const history = await instance.readHistory(false);
    expect(history.tailPage).toBe(2);
    expect(history.pageOrder).toBe("oldest-first");
    expect(history.assembled.records[0].record).toEqual(record);
    expect(history.pages.get(2).rootCount).toBe(1);
    expect(history.pages.get(2).length).toBeGreaterThan(50);
    expect(endpoints.map(endpoint => Number(new URL(`https://test${endpoint}`).searchParams.get("page")))).toEqual([1, 2, 3]);
    expect(instance.commentRootPages.get("root")).toBe(2);
  });

  it("hydrates embedded children immediately and falls back to their indexed root page when branches are empty", async () => {
    const record = { schema: "fyow.snapshot/3", snapshotId: "children-fallback", state: { archive: crypto.randomBytes(2500).toString("hex") } };
    const chunks = encodeCommentRecord(record);
    const root = {
      id: "root", account_id: "author", content: chunks[0], created_at: 100,
      children: chunks.slice(1).map((content: string, index: number) => ({ id: `reply-${index}`, account_id: "author", content, created_at: 200 }))
    };
    const endpoints: string[] = [];
    const instance = service({
      requestConsole: async (endpoint: string) => {
        endpoints.push(endpoint);
        return endpoint.startsWith("/comments/branches/") ? { data: [] } : { data: [root] };
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    expect(assembleCommentRecords(await instance.hydrateCommentReplies([root])).records[0].record).toEqual(record);
    expect(endpoints).toEqual([]);
    instance.commentRootPages.set("root", 4);
    const bareRoot = { ...root, children: [] };
    const hydrated = await instance.hydrateCommentReplies([bareRoot]);
    expect(assembleCommentRecords(hydrated).records[0].record).toEqual(record);
    expect(endpoints).toEqual(["/comments/branches/root", "/comments/work/1?page=4&limit=50&order=created_at_desc&filter_type=all"]);
  });

  it("does not locally apply truncated or mismatched-author posting responses", async () => {
    const instance = service({
      getAccount: () => ({ accountId: "author" }),
      requestConsole: async (_endpoint: string, options: any = {}) => ({ id: "root", account_id: "author", content: options.body.content.slice(0, -5) })
    });
    instance.work = { id: "work" };
    await expect(instance.postRecord({ schema: "fyow.event/3", eventId: "truncated" })).rejects.toThrow(/正文与提交分片不一致/);
    instance.requestConsole = async (_endpoint: string, options: any = {}) => ({ id: "root", account_id: "other", content: options.body.content });
    await expect(instance.postRecord({ schema: "fyow.event/3", eventId: "wrong-author" })).rejects.toThrow(/评论作者/);
    instance.requestConsole = async (_endpoint: string, options: any = {}) => ({ id: "reply", parent_id: "different-root", account_id: "author", content: options.body.content });
    await expect(instance.postRecord({ schema: "fyow.event/3", eventId: "wrong-branch" }, { parentId: "expected-root" })).rejects.toThrow(/评论分支/);
  });

  it("keeps unreadable branches incomplete and reports their read failure", async () => {
    const diagnostics: any[] = [];
    const instance = service({
      requestConsole: async () => { throw new Error("reply endpoint failure"); },
      onDiagnostic: (entry: any) => diagnostics.push(entry)
    });
    const chunks = encodeCommentRecord({ schema: "fyow.snapshot/3", snapshotId: "unreadable-branch", state: { archive: crypto.randomBytes(2000).toString("hex") } });
    const comments = await instance.hydrateCommentReplies([{ id: "root", account_id: "author", content: chunks[0] }]);
    const assembled = assembleCommentRecords(comments);
    expect(assembled.records).toHaveLength(0);
    expect(assembled.incomplete).toHaveLength(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "comment-branch-read-failed", rootCommentId: "root", page: 1, error: "reply endpoint failure"
    }));
  });

  it("publishes plain world chat without invoking the model and returns platform-timestamped state", async () => {
    const identity = generateOnlineWorldIdentity();
    const comments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "平台账号名" }),
      getIdentity: async () => identity,
      now: () => 9_999_999_999_999,
      requestModel: async () => { throw new Error("world chat must not invoke a model"); },
      requestConsole: async (_endpoint: string, options: any = {}) => {
        const item = { id: `chat-${comments.length + 1}`, account_id: "player", created_at: "2026-09-17T05:00:00.000Z", ...options.body };
        comments.push(item);
        return item;
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚", position: { x: 1, y: 1 } };
    const result = await instance.submitIntent({ type: "world-chat", text: "各位主公安好。", idempotencyKey: "same-chat" });
    expect(result.state.worldChat).toEqual([{
      messageId: expect.any(String), displayName: "晴岚", text: "各位主公安好。",
      createdAt: Date.parse("2026-09-17T05:00:00.000Z"), accountId: "player"
    }]);
    expect(result.state.modelUsageEvents).toEqual([]);
    const sentCount = comments.length;
    expect(await instance.submitIntent({ type: "world-chat", text: "各位主公安好。", idempotencyKey: "same-chat" })).toMatchObject({ duplicate: true });
    expect(comments).toHaveLength(sentCount);
    await expect(instance.submitIntent({ type: "world-chat", text: "<img src=x onerror=alert(1)>" })).rejects.toThrow(/纯文本/);
    await expect(instance.submitIntent({ type: "world-chat", text: "字".repeat(501) })).rejects.toThrow(/500/);
    instance.worldChatSendTimes = Array(12).fill(instance.now());
    await expect(instance.submitIntent({ type: "world-chat", text: "稍后发送" })).rejects.toThrow(/过于频繁/);
  });

  it("keeps only the newest fifty world-chat records by root platform time and enforces source, bans and reset epochs", () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player" }) });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    const message = (index: number, extra: any = {}) => {
      const record = signRecord({
        schema: "fyow.world-chat/1", messageId: `message-${index}`, gameId: "cc.aiero.fyow.grid-conquest",
        workId: "work", seasonId: "season", accountId: "player", displayName: "晴岚", text: `消息${index}`,
        createdAt: 100_000 - index, playerEpoch: 0, deviceSigningPublicKey: identity.signingPublicKey, ...extra
      }, identity.signingPrivateKey);
      return { record, sources: [{ id: `root-${String(index).padStart(3, "0")}`, account_id: "player", created_at: 100 + index }] };
    };
    const items = Array.from({ length: 65 }, (_, index) => message(index)).reverse();
    instance.applyWorldChatRecords([...items, items[0]], { replace: true });
    expect(instance.state().worldChat).toHaveLength(50);
    expect(instance.worldChat).toHaveLength(50);
    expect(instance.state().worldChat[0]).toMatchObject({ text: "消息15", createdAt: 115_000 });
    expect(instance.state().worldChat.at(-1)).toMatchObject({ text: "消息64", createdAt: 164_000 });
    const wrongAuthor = message(80);
    wrongAuthor.sources[0]!.account_id = "intruder";
    expect(instance.applyWorldChatRecord(wrongAuthor)).toBe(false);
    expect(instance.applyWorldChatRecord(message(80, { workId: "other" }))).toBe(false);
    expect(instance.applyWorldChatRecord(message(80, { displayName: "冒名玩家" }))).toBe(false);
    const forged = message(80);
    forged.record.text = "改过的正文";
    expect(instance.applyWorldChatRecord(forged)).toBe(false);
    instance.world.bans.player = { banned: true };
    expect(instance.state().worldChat).toEqual([]);
    expect(instance.applyWorldChatRecord(message(81))).toBe(false);
    instance.world.bans.player.banned = false;
    instance.world.playerEpochs.player = 1;
    expect(instance.state().worldChat).toEqual([]);
    expect(instance.applyWorldChatRecord(message(82))).toBe(false);
    expect(instance.applyWorldChatRecord(message(83, { playerEpoch: 1 }))).toBe(true);
  });

  it("isolates cached world chat when migration reuses the season id on a new work", () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player" }) });
    instance.work = { id: "source-work", authorAccountId: "author" };
    instance.control = { seasonId: "shared-season", authorityAccountId: "author", startedAt: 1_000 };
    instance.world = createWorld({ seasonId: "shared-season", authorityAccountId: "author", startedAt: 1_000 });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    const record = signRecord({
      schema: "fyow.world-chat/1", messageId: "source-chat", gameId: "cc.aiero.fyow.grid-conquest",
      workId: "source-work", seasonId: "shared-season", serverStartedAt: 1_000,
      accountId: "player", displayName: "晴岚", text: "旧服消息", playerEpoch: 0,
      deviceSigningPublicKey: identity.signingPublicKey
    }, identity.signingPrivateKey);
    expect(instance.applyWorldChatRecord({ record, sources: [{ id: "source-comment", account_id: "player", created_at: 2 }] })).toBe(true);
    expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["旧服消息"]);

    instance.work = { id: "target-work", authorAccountId: "author" };
    instance.control = { seasonId: "shared-season", authorityAccountId: "author", startedAt: 3_000 };
    instance.world = createWorld({ seasonId: "shared-season", authorityAccountId: "author", startedAt: 3_000 });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    expect(instance.state().worldChat).toEqual([]);
    const staleEpochRecord = signRecord({
      ...record,
      messageId: "stale-epoch-chat",
      workId: "target-work"
    }, identity.signingPrivateKey);
    expect(instance.applyWorldChatRecord({
      record: staleEpochRecord,
      sources: [{ id: "stale-epoch-comment", account_id: "player", created_at: 4 }]
    })).toBe(false);

    instance.restoreWorldChatCache({
      worldChat: [
        { messageId: "legacy-source", accountId: "player", displayName: "晴岚", text: "旧版误带入", createdAt: 2_000, seasonId: "shared-season" },
        { messageId: "legacy-target", accountId: "player", displayName: "晴岚", text: "目标服消息", createdAt: 4_000, seasonId: "shared-season" }
      ],
      worldChatCursor: { initialized: true, seasonId: "shared-season", order: { timestamp: 2_000, commentId: "old" } }
    });
    expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["目标服消息"]);
    expect(instance.worldChatCursor).toBeNull();
  });

  it("deduplicates chat per author and retains the earliest platform root when a retry arrives first", () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player" }) });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    instance.world.players.other = { accountId: "other", displayName: "清音" };
    const message = (accountId: string, timestamp: number) => ({
      record: signRecord({
        schema: "fyow.world-chat/1", messageId: "same-wire-id", gameId: "cc.aiero.fyow.grid-conquest",
        workId: "work", seasonId: "season", accountId, displayName: instance.world.players[accountId].displayName,
        text: accountId, playerEpoch: 0, deviceSigningPublicKey: identity.signingPublicKey
      }, identity.signingPrivateKey),
      sources: [{ id: `${accountId}-${timestamp}`, account_id: accountId, created_at: timestamp }]
    });
    expect(instance.applyWorldChatRecord(message("player", 200))).toBe(true);
    expect(instance.applyWorldChatRecord(message("player", 100))).toBe(true);
    expect(instance.applyWorldChatRecord(message("player", 300))).toBe(false);
    expect(instance.applyWorldChatRecord(message("other", 150))).toBe(true);
    expect(instance.state().worldChat).toMatchObject([
      { accountId: "player", createdAt: 100_000 },
      { accountId: "other", createdAt: 150_000 }
    ]);
  });

  it("continues the separate chat read past a ledger snapshot to recover the newest fifty messages", async () => {
    const identity = generateOnlineWorldIdentity();
    const snapshot = signRecord({
      schema: "fyow.snapshot/3", snapshotId: "new-snapshot", gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season", revision: 10,
      state: {}, stateHash: crypto.createHash("sha256").update("{}").digest("hex"), ledgerCoverage: { version: 1, through: { timestamp: 300_000, commentId: "" } }
    }, identity.signingPrivateKey);
    const control = signRecord({
      schema: "fyow.control/3", id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season",
      authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey
    }, identity.signingPrivateKey);
    const chatComments = Array.from({ length: 65 }, (_, index) => {
      const record = signRecord({
        schema: "fyow.world-chat/1", messageId: `history-chat-${index}`, gameId: "cc.aiero.fyow.grid-conquest",
        workId: "work", seasonId: "season", accountId: "player", displayName: "晴岚", text: `历史${index}`,
        createdAt: 9_999_999 - index, playerEpoch: 0, deviceSigningPublicKey: identity.signingPublicKey
      }, identity.signingPrivateKey);
      return encodeCommentRecord(record).map((content: string, part: number) => ({
        id: `chat-${index}-${part}`, account_id: "player", created_at: 100 + index, content
      }));
    }).flat();
    const roots = [
      ...chatComments,
      ...Array.from({ length: 80 }, (_, index) => ({ id: `filler-${index}`, account_id: "author", content: "普通评论", created_at: 200 + index })),
      ...encodeCommentRecord(snapshot).map((content: string, index: number) => ({ id: `snapshot-${index}`, account_id: "author", content, created_at: 400 })),
      ...encodeCommentRecord(control).map((content: string, index: number) => ({ id: `control-${index}`, account_id: "author", content, created_at: 401 }))
    ];
    const instance = service({
      getAccount: () => ({ accountId: "player" }),
      requestConsole: async (endpoint: string) => {
        const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
        return roots.slice((page - 1) * 50, page * 50);
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    const history = await instance.readHistory(true);
    expect(instance.history.stoppedBy).toBe("oldest-page");
    expect(history.assembled.records.filter((item: any) => item.record.schema === "fyow.world-chat/1")).toHaveLength(65);
    const chats = await instance.readWorldChatHistory(history);
    instance.applyWorldChatRecords(chats.assembled.records, { replace: true });
    expect(instance.state().worldChat).toHaveLength(50);
    expect(instance.state().worldChat[0].text).toBe("历史15");
    expect(instance.state().worldChat.at(-1).text).toBe("历史64");
  });

  it("persists an incremental chat watermark even when fewer than fifty messages exist", async () => {
    const identity = generateOnlineWorldIdentity();
    const makeChat = (id: string, time: number) => encodeCommentRecord(signRecord({
      schema: "fyow.world-chat/1", messageId: id, gameId: "cc.aiero.fyow.grid-conquest",
      workId: "work", seasonId: "season", accountId: "player", displayName: "晴岚", text: id,
      playerEpoch: 0, deviceSigningPublicKey: identity.signingPublicKey
    }, identity.signingPrivateKey)).map((content: string, part: number) => ({ id: `${id}-${part}`, account_id: "player", created_at: time, content }));
    const roots = [
      ...makeChat("old-chat", 1),
      ...Array.from({ length: 155 }, (_, index) => ({ id: `ordinary-${index}`, account_id: "author", created_at: 10 + index, content: "普通评论" }))
    ];
    const requested: number[] = [];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-chat-watermark-"));
    try {
      const instance = service({
        cacheFile: path.join(directory, "cache.json"),
        getAccount: () => ({ accountId: "player" }),
        requestConsole: async (endpoint: string) => {
          const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
          requested.push(page);
          return roots.slice((page - 1) * 50, page * 50);
        }
      });
      instance.work = { id: "work", authorAccountId: "author" };
      instance.control = { seasonId: "season", authorityAccountId: "author" };
      instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
      instance.world.players.player = { accountId: "player", displayName: "晴岚" };
      instance.historyPageOrder = "oldest-first";
      const first = await instance.readWorldChatHistory();
      instance.applyWorldChatRecords(first.assembled.records);
      expect(first.pagesScanned).toBe(4);
      expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["old-chat"]);
      instance.saveCache();
      const cached = instance.loadCache("work");
      expect(cached.worldChatCursor).toMatchObject({ initialized: true, seasonId: "season", tailPage: 4 });

      instance.worldChat = cached.worldChat;
      instance.worldChatCursor = cached.worldChatCursor;
      requested.splice(0);
      const unchanged = await instance.readWorldChatHistory();
      instance.applyWorldChatRecords(unchanged.assembled.records);
      expect(unchanged).toMatchObject({ incremental: true, pagesScanned: 1, reachedHistoryBoundary: true });
      expect(requested).toEqual([1, 4, 5]);
      expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["old-chat"]);

      roots.push(...makeChat("new-chat", 300));
      requested.splice(0);
      const newest = await instance.readWorldChatHistory();
      instance.applyWorldChatRecords(newest.assembled.records);
      expect(newest.pagesScanned).toBe(1);
      expect(requested).toEqual([1, 4, 5]);
      expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["old-chat", "new-chat"]);
      roots.push(...encodeCommentRecord({ schema: "fyow.snapshot/3", snapshotId: "after-chat", revision: 9 }).map((content: string, index: number) => ({
        id: `after-chat-${index}`, account_id: "author", created_at: 301, content
      })));
      const afterSnapshot = await instance.readWorldChatHistory();
      instance.applyWorldChatRecords(afterSnapshot.assembled.records);
      expect(afterSnapshot.pagesScanned).toBe(1);
      expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["old-chat", "new-chat"]);
      instance.world.bans.player = { banned: true };
      expect(instance.state().worldChat).toEqual([]);
      instance.world.bans.player.banned = false;
      instance.world.playerEpochs.player = 1;
      expect(instance.state().worldChat).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries incomplete chat branches across watermark polls without duplicating cached fragments", async () => {
    const identity = generateOnlineWorldIdentity();
    const record = signRecord({
      schema: "fyow.world-chat/1", messageId: "late-branch", gameId: "cc.aiero.fyow.grid-conquest",
      workId: "work", seasonId: "season", accountId: "player", displayName: "晴岚",
      text: crypto.randomBytes(250).toString("hex"), playerEpoch: 0, deviceSigningPublicKey: identity.signingPublicKey
    }, identity.signingPrivateKey);
    const chunks = encodeCommentRecord(record);
    expect(chunks.length).toBeGreaterThan(1);
    const root = { id: "root", account_id: "player", created_at: 100, content: chunks[0] };
    let repliesReady = false;
    const instance = service({
      requestConsole: async (endpoint: string) => new URL(`https://test${endpoint}`).searchParams.get("page") === "1" ? [root] : [],
      getAccount: () => ({ accountId: "player" })
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚" };
    instance.historyPageOrder = "newest-first";
    instance.readCommentBranches = async () => repliesReady
      ? chunks.slice(1).map((content: string, index: number) => ({ id: `reply-${index}`, account_id: "player", parent_id: "root", content, created_at: 200 }))
      : [];
    await instance.readWorldChatHistory();
    await instance.readWorldChatHistory();
    expect(instance.worldChatCursor.pendingChunks).toHaveLength(1);
    repliesReady = true;
    const recovered = await instance.readWorldChatHistory();
    instance.applyWorldChatRecords(recovered.assembled.records);
    expect(instance.worldChatCursor.pendingChunks).toHaveLength(0);
    expect(instance.state().worldChat).toMatchObject([{ messageId: "late-branch", createdAt: 100_000 }]);
  });

  it("loads the latest fifty chats on cold open and restart while a newer control preserves the existing world", async () => {
    const authorIdentity = generateOnlineWorldIdentity();
    const playerIdentity = generateOnlineWorldIdentity();
    const workId = "4ac2ab60-67ff-459d-ae9a-6274f1802195";
    const baseTime = Date.parse("2026-09-17T00:00:00.000Z");
    const program = packProgram({ gameId: "cc.aiero.fyow.grid-conquest", title: "聊天重启测试", html: "<!doctype html><html><body>test</body></html>" });
    const world = createWorld({ seed: "preserved-world", seasonId: "preserved-season", authorityAccountId: "author", startedAt: baseTime });
    world.players.player = {
      accountId: "player", displayName: "晴岚", deviceSigningPublicKey: playerIdentity.signingPublicKey,
      position: { x: 1, y: 1 }, gold: 100, joinedAt: baseTime, carriedGeneralIds: [], fieldArmySoldiers: 0
    };
    world.cells["1,1"] = { ownerAccountId: "player", soldiers: 0, generalIds: [] };
    world.treasureEpoch = 5;
    world.treasureSpawns.keep = { id: "keep", epoch: 5, x: 2, y: 1, materialId: "white", spawnedAt: baseTime };
    const roots: any[] = [];
    const append = (record: any, accountId: string, createdAt: number) => {
      const chunks = encodeCommentRecord(record);
      const rootId = `entry-${String(roots.length).padStart(4, "0")}`;
      roots.push({
        id: rootId, account_id: accountId, created_at: createdAt, content: chunks[0],
        children: chunks.slice(1).map((content: string, index: number) => ({
          id: `${rootId}-reply-${index}`, account_id: accountId, created_at: createdAt + index + 1, content
        }))
      });
    };
    const control = (id: string) => signRecord({
      schema: "fyow.control/3", id, gameId: world.gameId, workId, seasonId: world.seasonId,
      programHash: program.digest, authorityAccountId: "author", authoritySigningPublicKey: authorIdentity.signingPublicKey,
      authorityEncryptionPublicKey: authorIdentity.encryptionPublicKey, startedAt: baseTime
    }, authorIdentity.signingPrivateKey);
    append(control("original-control"), "author", baseTime + 1);
    const publicState = JSON.parse(JSON.stringify(world));
    delete publicState.privatePlayers;
    const { canonicalJson, sha256 } = require("../electron/online-world-protocol.cjs");
    append(signRecord({
      schema: "fyow.snapshot/3", snapshotId: "existing-world", gameId: world.gameId, workId, seasonId: world.seasonId,
      state: publicState, stateHash: sha256(Buffer.from(canonicalJson(publicState))), revision: 0
    }, authorIdentity.signingPrivateKey), "author", baseTime + 2);
    const appendChat = (index: number) => append(signRecord({
      schema: "fyow.world-chat/1", messageId: `restart-${index}`, gameId: world.gameId, workId, seasonId: world.seasonId,
      accountId: "player", displayName: "晴岚", text: `消息${index}`, playerEpoch: 0,
      deviceSigningPublicKey: playerIdentity.signingPublicKey
    }, playerIdentity.signingPrivateKey), "player", baseTime + 10 + index * 10);
    for (let index = 0; index < 65; index += 1) appendChat(index);
    append(control("updated-control"), "author", baseTime + 655);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-chat-restart-"));
    const instances: any[] = [];
    try {
      const create = () => {
        const instance = service({
          cacheFile: path.join(directory, "cache.json"), now: () => baseTime + 10_000,
          getAccount: () => ({ accountId: "player", username: "玩家" }), getIdentity: async () => playerIdentity,
          requestConsole: async (endpoint: string, options: any = {}) => {
            if (options.method === "POST") throw new Error("read-only open should not post comments");
            if (endpoint.startsWith("/installed-apps/")) return { id: workId, created_by_account_id: "author", description: program.envelope };
            if (endpoint.startsWith("/comments/branches/")) return [];
            const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
            return { data: roots.slice((page - 1) * 50, page * 50) };
          }
        });
        instances.push(instance);
        return instance;
      };
      const first = create();
      await first.open({ workUrl: `https://aigirlfriend.baby/zh/explore/installed/${workId}` });
      expect(first.control.id).toBe("updated-control");
      expect(first.state().worldChat.map((item: any) => item.text)).toEqual(Array.from({ length: 50 }, (_, index) => `消息${index + 15}`));
      first.world.players.player.gold = 777;
      first.world.privatePlayers.player.materials = { white: 3 };
      first.close();
      for (let index = 65; index < 72; index += 1) appendChat(index);
      append(control("newest-control"), "author", baseTime + 1000);
      const restarted = create();
      await restarted.open({ workUrl: `https://aigirlfriend.baby/zh/explore/installed/${workId}` });
      expect(restarted.control.id).toBe("newest-control");
      expect(restarted.state().worldChat.map((item: any) => item.text)).toEqual(Array.from({ length: 50 }, (_, index) => `消息${index + 22}`));
      expect(restarted.world).toMatchObject({ seasonId: "preserved-season", seed: "preserved-world", treasureEpoch: 5 });
      expect(restarted.world.treasureSpawns.keep).toBeTruthy();
      expect(restarted.world.players.player.gold).toBe(777);
      expect(restarted.world.privatePlayers.player.materials.white).toBe(3);
      expect(restarted.world.cells["1,1"].ownerAccountId).toBe("player");
    } finally {
      for (const instance of instances) instance.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes author treasure scattering through its own renderer confirmation without a player target", async () => {
    const renderer = fs.readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const start = renderer.indexOf('if(event.data.type==="admin"){');
    const end = renderer.indexOf('if(event.data.type==="preferences"){', start);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const handler = new AsyncFunction("event", "confirmAction", "api", "onlineWorldState", "replyResult", "replyError", "renderOnlineWorld", "toast", renderer.slice(start, end));
    const calls: any[] = [];
    const replies: any[] = [];
    const errors: any[] = [];
    const event = { data: { type: "admin", command: { type: "scatter-treasures", count: 12, redAscend: 1, redReroll: 2 } } };
    const api = { administerOnlineWorld: async (command: any) => { calls.push(command); return { state: { revision: 2 } }; } };
    await handler(event, async () => true, api, { isServerOwner: true, world: { players: {} } }, (result: any) => replies.push(result), (error: any) => errors.push(error), () => {}, () => {});
    expect(errors).toEqual([]);
    expect(calls).toEqual([event.data.command]);
    expect(replies[0]).toMatchObject({ admin: true, state: { revision: 2 } });
    await handler(event, async () => false, api, { isServerOwner: true }, (result: any) => replies.push(result), (error: any) => errors.push(error), () => {}, () => {});
    expect(calls).toHaveLength(1);
    expect(replies.at(-1)).toEqual({ cancelled: true });
    await handler({ data: { type: "admin", command: { ...event.data.command, count: -1 } } }, async () => true, api, { isServerOwner: true }, () => {}, (error: any) => errors.push(error), () => {}, () => {});
    expect(errors.at(-1).message).toMatch(/数量无效/);
    await handler(event, async () => true, api, { isServerOwner: false }, () => {}, (error: any) => errors.push(error), () => {}, () => {});
    expect(errors.at(-1).message).toMatch(/仅本游戏服主/);
    expect(calls).toHaveLength(1);
  });

  it("quotes a march while an action is pending without mutating state or sending a request", async () => {
    const instance = service({
      getAccount: () => ({ accountId: "player" }),
      now: () => 1_000_000,
      requestConsole: async () => { throw new Error("read-only quote must not use transport"); }
    });
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚", position: { x: 1, y: 1 }, carriedGeneralIds: [] };
    const pending = new Promise(() => {});
    instance.intentInFlight = pending;
    instance.intentInFlightKey = "pending-action";
    instance.status = "degraded";
    const before = JSON.stringify(instance.world);
    const result = await instance.submitIntent({ type: "quote-march", to: { x: 3, y: 1 }, soldiers: 5, generalIds: [], attack: false, requestKey: "hover:3,1" });
    expect(result.marchQuote).toMatchObject({ revision: 0, from: { x: 1, y: 1 }, to: { x: 3, y: 1 }, distance: 2, soldiers: 5 });
    expect(result.marchQuote.requestKey).toBe(JSON.stringify({
      to: { x: 3, y: 1 }, soldiers: 5, attack: false, revision: 0, from: { x: 1, y: 1 }
    }));
    expect(result.marchQuote.cost).toBeGreaterThan(0);
    expect(result.marchQuote.durationMs).toBeGreaterThan(0);
    expect(JSON.stringify(instance.world)).toBe(before);
    expect(instance.intentInFlight).toBe(pending);
    expect(instance.intentInFlightKey).toBe("pending-action");
    instance.world.bans.player = { banned: true };
    await expect(instance.submitIntent({ type: "quote-march", to: { x: 3, y: 1 }, soldiers: 0 })).rejects.toThrow(/封禁/);
  });

  it("rejects a stale march quote through the formal service path without charging or creating a job", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "晴岚" }),
      getIdentity: async () => identity,
      now: () => 1_000_000
    });
    instance.status = "ready";
    instance.control = { authorityAccountId: "author" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author", startedAt: 1_000_000 });
    instance.world.players.player = {
      accountId: "player", displayName: "晴岚", position: { x: 1, y: 1 },
      gold: 1_000, fieldArmySoldiers: 10, carriedGeneralIds: [], basePower: 500, trainingLevel: 0, power: 500
    };
    instance.world.privatePlayers.player = { orientation: "any" };
    instance.world.cells["1,1"] = { ownerAccountId: "player", soldiers: 0, generalIds: [] };
    const quote = (await instance.submitIntent({
      type: "quote-march", to: { x: 3, y: 1 }, soldiers: 5, attack: false
    })).marchQuote;
    instance.world.revision += 1;
    const before = structuredClone(instance.world);

    const submission = instance.submitIntent({
      type: "march", to: { x: 3, y: 1 }, soldiers: 5, attack: false,
      expectedQuote: {
        revision: quote.revision, requestKey: quote.requestKey, path: quote.path,
        cost: quote.cost, durationMs: quote.durationMs
      },
      idempotencyKey: "stale-march-quote"
    });

    await expect(submission).rejects.toMatchObject({
      code: "FYOW_MARCH_QUOTE_CHANGED",
      errorCode: "FYOW_MARCH_QUOTE_CHANGED"
    });
    expect(instance.world).toEqual(before);
    expect(instance.world.players.player.gold).toBe(1_000);
    expect(instance.world.players.player.fieldArmySoldiers).toBe(10);
    expect(instance.world.jobs).toEqual({});
  });

  it("reports a failed in-flight sync as an unsubmitted action instead of exposing fetch internals", async () => {
    const instance = service({ getAccount: () => ({ accountId: "player" }) });
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "晴岚", position: { x: 1, y: 1 }, carriedGeneralIds: [] };
    instance.world.privatePlayers.player = { orientation: "any" };
    instance.world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    instance.status = "degraded";
    instance.syncInFlight = Promise.reject(new Error("Failed to fetch"));
    await expect(instance.submitIntent({ type: "start-mining", x: 1, y: 1, auto: true, idempotencyKey: "offline-mine" }))
      .rejects.toThrow(/平台连接暂时中断.*行动尚未提交/);
    expect(instance.world.jobs).toEqual({});
  });

  it("reconnects a degraded cached world before accepting an action", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player", username: "玩家" }), getIdentity: async () => identity });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "玩家", gold: 500, position: { x: 1, y: 1 }, carriedGeneralIds: [] };
    instance.world.privatePlayers.player = { orientation: "any" };
    instance.world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    instance.status = "degraded";
    instance.sync = vi.fn(async () => { instance.status = "ready"; return instance.state(); });
    const result = await instance.submitIntent({ type: "start-mining", x: 1, y: 1, auto: true, idempotencyKey: "reconnected-mine" });
    expect(instance.sync).toHaveBeenCalledWith(false);
    expect(result.event.type).toBe("start-mining");
  });

  it("lets only the author scatter configured treasure batches and excludes materials from public snapshots", async () => {
    const identity = generateOnlineWorldIdentity();
    const start = Date.parse("2026-09-17T00:00:00.000Z");
    const now = start + 6 * 60 * 60 * 1000;
    const comments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      now: () => now,
      requestConsole: async (_endpoint: string, options: any = {}) => {
        const item = { id: `treasure-${String(comments.length + 1).padStart(4, "0")}`, account_id: "author", created_at: new Date(now + comments.length).toISOString(), ...options.body };
        comments.push(item);
        return item;
      }
    });
    instance.world = createWorld({ seed: "treasure-service", seasonId: "season", authorityAccountId: "author", startedAt: start });
    instance.world.privatePlayers.author = { materials: { white: 7 } };
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey };
    const result = await instance.administer({ type: "scatter-treasures", count: 8, redAscend: 2, redReroll: 1 });
    expect(result.command).toMatchObject({ type: "scatter-treasures", authorityId: expect.any(String) });
    expect(result.state.world.treasureEpoch).toBe(1);
    expect(Object.keys(result.state.world.treasureSpawns)).toHaveLength(8);
    expect(Object.values(result.state.world.treasureSpawns).filter((item: any) => item.materialId === "red-ascend")).toHaveLength(2);
    expect(Object.values(result.state.world.treasureSpawns).filter((item: any) => item.materialId === "red-reroll")).toHaveLength(1);
    const records = assembleCommentRecords(comments).records.map((item: any) => item.record);
    expect(records.find((record: any) => record.schema === "fyow.authority/1")).toMatchObject({ type: "treasure-scatter", treasureEpoch: 1 });
    const snapshot = records.find((record: any) => record.schema === "fyow.snapshot/3");
    expect(snapshot.state.treasureSpawns).toEqual(instance.world.treasureSpawns);
    expect(snapshot.state.privatePlayers).toBeUndefined();
    const previousCount = comments.length;
    await instance.administer({ type: "scatter-treasures", count: 8 });
    expect(comments.length).toBeGreaterThan(previousCount);
    expect(instance.world.treasureEpoch).toBe(2);
    instance.getAccount = () => ({ accountId: "guest" });
    await expect(instance.administer({ type: "scatter-treasures" })).rejects.toThrow(/服主指令/);
  });

  it("serializes author scattering with player actions and rejects overlapping refreshes", async () => {
    const identity = generateOnlineWorldIdentity();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const comments: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => { await gate; return identity; },
      requestConsole: async (_endpoint: string, options: any = {}) => {
        const item = { id: `admin-${String(comments.length).padStart(4, "0")}`, account_id: "author", created_at: 100 + comments.length, ...options.body };
        comments.push(item);
        return item;
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    const first = instance.administer({ type: "scatter-treasures", count: 5 });
    await expect(instance.administer({ type: "scatter-treasures", count: 8 })).rejects.toThrow(/上一项行动/);
    await expect(instance.submitIntent({ type: "join", idempotencyKey: "during-admin" })).rejects.toThrow(/上一项行动/);
    await expect(instance.sync()).resolves.toMatchObject({ syncing: false });
    expect(comments).toHaveLength(0);
    release();
    await first;
    expect(instance.world.treasureEpoch).toBe(1);
    expect(instance.intentInFlight).toBeNull();
    await instance.administer({ type: "scatter-treasures", count: 8 });
    expect(instance.world.treasureEpoch).toBe(2);
  });

  it("orders competing treasure claims by platform time and reconciles a losing local material reward only once", () => {
    const firstIdentity = generateOnlineWorldIdentity();
    const secondIdentity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "first" }) });
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world.treasureEpoch = 1;
    instance.world.treasureSpawns["treasure-1"] = { id: "treasure-1", epoch: 1, x: 2, y: 3, materialId: "white", spawnedAt: 1000 };
    instance.world.privatePlayers.first = { materials: { white: 2 }, treasureClaimRewards: { "treasure-1": { materialId: "white", reconciled: false } } };
    const claim = (actor: string, identity: any, timestamp: number) => ({
      record: signRecord({
        schema: "fyow.map-delta/1", mapDeltaId: `claim-${actor}`, gameId: "cc.aiero.fyow.grid-conquest",
        workId: "work", seasonId: "season", actorAccountId: actor, participant: { displayName: actor },
        playerEpoch: 0, deviceSigningPublicKey: identity.signingPublicKey, deviceEncryptionPublicKey: identity.encryptionPublicKey,
        changes: { cells: {}, generals: {}, claimedTreasures: { "treasure-1": { treasureId: "treasure-1", epoch: 1, x: 2, y: 3, materialId: "white", accountId: actor, claimedAt: 9_999_999 } } }
      }, identity.signingPrivateKey),
      sources: [{ id: `claim-root-${actor}`, account_id: actor, created_at: timestamp }]
    });
    expect(instance.applyMapDelta(claim("first", firstIdentity, 300))).toBe(true);
    expect(instance.world.claimedTreasures["treasure-1"].accountId).toBe("first");
    expect(instance.world.treasureSpawns["treasure-1"]).toBeUndefined();
    expect(instance.applyMapDelta(claim("second", secondIdentity, 200))).toBe(true);
    expect(instance.world.claimedTreasures["treasure-1"].accountId).toBe("second");
    instance.reconcileTreasureRewards();
    instance.reconcileTreasureRewards();
    expect(instance.world.privatePlayers.first.materials.white).toBe(2);
    const history = { confirmationComplete: true, assembled: { incomplete: [], records: [claim("first", firstIdentity, 300), claim("second", secondIdentity, 200)] } };
    instance.reconcileTreasureRewards(history);
    instance.reconcileTreasureRewards(history);
    expect(instance.world.privatePlayers.first.materials.white).toBe(1);
    const forged = claim("first", firstIdentity, 400);
    forged.record = signRecord({ ...forged.record, mapDeltaId: "forged-scatter", changes: { ...forged.record.changes, treasureSpawns: { fake: {} } } }, firstIdentity.signingPrivateKey);
    expect(instance.applyMapDelta(forged)).toBe(false);
  });

  it("credits a conquered treasure immediately and removes it only if the public claim loses", async () => {
    const identity = generateOnlineWorldIdentity();
    const rivalIdentity = generateOnlineWorldIdentity();
    const now = 1_000_000 + 6 * 60 * 60 * 1000;
    const comments: any[] = [];
    const makeInstance = () => {
      const instance = service({
        getAccount: () => ({ accountId: "player", username: "玩家" }),
        getIdentity: async () => identity,
        now: () => now,
        requestConsole: async (_endpoint: string, options: any = {}) => {
          const item = { id: `pending-${comments.length}`, account_id: "player", created_at: now + comments.length, ...options.body };
          comments.push(item);
          return item;
        }
      });
      instance.work = { id: "work", authorAccountId: "author" };
      instance.control = { seasonId: "season", authorityAccountId: "author" };
      instance.world = createWorld({ seed: "held-material", seasonId: "season", authorityAccountId: "author", startedAt: 1_000_000 });
      instance.world.players.player = {
        accountId: "player", displayName: "晴岚", joinedAt: 1_000_000, gold: 20_000,
        position: { x: 1, y: 1 }, carriedGeneralIds: ["general"], fieldArmySoldiers: 0
      };
      instance.world.privatePlayers.player = { materials: { white: 0 } };
      instance.world.generals.general = createFallbackGeneral({ id: "general", name: "青禾", gender: "female", holderAccountId: "player", power: 300 });
      instance.world.generals.general.status = "carried";
      instance.world.generals.general.experience = 100;
      instance.world.treasureSpawns["treasure-1"] = { id: "treasure-1", epoch: 1, x: 2, y: 1, materialId: "white", spawnedAt: 1_000_000 };
      instance.world.treasureEpoch = 1;
      instance.world.jobs.conquest = {
        id: "conquest", type: "march", accountId: "player", from: { x: 1, y: 1 }, to: { x: 2, y: 1 },
        generalIds: ["general"], activeGeneralIds: ["general"], soldiers: 20_000, attack: true, startedAt: now - 1000, finishAt: now
      };
      return instance;
    };
    const instance = makeInstance();
    const cultivation = { type: "cultivate-general", generalId: "general", goldInvestment: 5000, materialId: "white", idempotencyKey: "cultivate" };
    await instance.settleLocalClock();
    expect(instance.world.players.player.position).toEqual({ x: 2, y: 1 });
    expect(instance.world.privatePlayers.player.materials.white).toBe(1);
    expect(instance.world.privatePlayers.player.battleReports[0].treasures).toEqual([{ treasureId: "treasure-1", materialId: "white", amount: 1 }]);
    expect(instance.world.generals.general.cultivationCount).toBe(0);
    const own = assembleCommentRecords(comments).records.find((item: any) => item.record.changes?.claimedTreasures?.["treasure-1"]);
    expect(own).toBeTruthy();
    expect(instance.pendingTreasureRewards()).toHaveLength(1);
    instance.reconcileTreasureRewards({ confirmationComplete: false, assembled: { records: [own], incomplete: [] } });
    expect(instance.world.privatePlayers.player.materials.white).toBe(1);
    instance.reconcileTreasureRewards({ confirmationComplete: true, assembled: { records: [own], incomplete: [] } });
    instance.reconcileTreasureRewards({ confirmationComplete: true, assembled: { records: [own], incomplete: [] } });
    expect(instance.world.privatePlayers.player.materials.white).toBe(1);
    await instance.submitIntent({ ...cultivation, idempotencyKey: "confirmed-cultivate" });
    expect(instance.world.generals.general.cultivationCount).toBe(1);
    expect(instance.world.privatePlayers.player.materials.white).toBe(0);

    comments.splice(0);
    const loser = makeInstance();
    await loser.settleLocalClock();
    expect(loser.world.privatePlayers.player.materials.white).toBe(1);
    const loserOwn = assembleCommentRecords(comments).records.find((item: any) => item.record.changes?.claimedTreasures?.["treasure-1"]);
    const competingRecord = signRecord({
      ...loserOwn.record, mapDeltaId: "earlier-rival", actorAccountId: "rival",
      deviceSigningPublicKey: rivalIdentity.signingPublicKey, deviceEncryptionPublicKey: rivalIdentity.encryptionPublicKey,
      changes: { cells: {}, generals: {}, claimedTreasures: { "treasure-1": { ...loserOwn.record.changes.claimedTreasures["treasure-1"], accountId: "rival" } } }
    }, rivalIdentity.signingPrivateKey);
    const competing = { record: competingRecord, sources: [{ id: "earlier", account_id: "rival", created_at: now - 1 }] };
    loser.reconcileTreasureRewards({ confirmationComplete: true, assembled: { records: [loserOwn, competing], incomplete: [] } });
    expect(loser.world.privatePlayers.player.materials.white).toBe(0);
    expect(loser.world.privatePlayers.player.treasureClaimRewards["treasure-1"].status).toBe("rejected");
    expect(loser.world.privatePlayers.player.battleReports[0].treasures).toEqual([]);
    await expect(loser.submitIntent(cultivation)).rejects.toThrow(/素材不足/);
    expect(loser.world.generals.general.cultivationCount).toBe(0);
    expect(loser.world.players.player.gold).toBe(20_000);
  });

  it("scans past a newer snapshot and known comments when a material claim still needs confirmation", async () => {
    const comments = [
      ...Array.from({ length: 50 }, (_, index) => ({ id: `old-${index}`, content: "评论", created_at: 100 + index })),
      ...encodeCommentRecord({ schema: "fyow.snapshot/3", snapshotId: "pending-snapshot", seasonId: "season", revision: 8 }).map((content: string, index: number) => ({ id: `pending-snapshot-${index}`, content, created_at: 200 })),
      ...encodeCommentRecord({ schema: "fyow.control/3", id: "control", seasonId: "season" }).map((content: string, index: number) => ({ id: `control-${index}`, content, created_at: 201 }))
    ];
    const instance = service({
      getAccount: () => ({ accountId: "player" }),
      requestConsole: async (endpoint: string) => {
        const page = Number(new URL(`https://test${endpoint}`).searchParams.get("page"));
        return comments.slice((page - 1) * 50, page * 50);
      }
    });
    instance.work = { id: "work" };
    instance.world = createWorld({ seasonId: "season" });
    instance.world.privatePlayers.player = { materials: { white: 0 }, treasureClaimRewards: {
      treasure: { status: "pending", materialId: "white", amount: 1, scanFrom: { timestamp: 120_000, commentId: "old-20" } }
    } };
    instance.knownCommentIds.add("control-0");
    const history = await instance.readHistory(false);
    expect(history.comments.some((comment: any) => comment.id === "old-0")).toBe(true);
    expect(history.confirmationComplete).toBe(true);
  });

  it("replays unseen claims and map deltas below snapshot publication without overwriting newer included keys", async () => {
    const fixture = coverageHarness();
    const { author, base, map } = fixture;
    const general = (id: string, holder: string, name: string, x: number) => ({
      ...createFallbackGeneral({ id, name, gender: "female", holderAccountId: holder, power: 300 }),
      status: "deployed", location: { x, y: x }
    });
    const missed = map("player", 150, {
      cells: {
        "2,2": { ownerAccountId: "player", soldiers: 10, generalIds: ["shared"] },
        "3,3": { ownerAccountId: "player", soldiers: 10, generalIds: ["remote"] }
      },
      generals: { shared: general("shared", "player", "较早", 2), remote: general("remote", "player", "远端", 3) },
      claimedTreasures: { old: { treasureId: "old", epoch: 1, x: 1, y: 1, materialId: "white", accountId: "player", claimedAt: base + 150 } }
    });
    const included = map("author", 180, {
      cells: { "2,2": { ownerAccountId: "author", soldiers: 20, generalIds: ["shared"] } },
      generals: { shared: general("shared", "author", "较新", 2) }
    });
    expect(author.applyMapDelta(included)).toBe(true);
    author.publicHistoryOrder = { timestamp: base + 100, commentId: "" };
    await author.administer({ type: "scatter-treasures", count: 2 });
    const snapshots = assembleCommentRecords(require("../electron/online-world-protocol.cjs").extractCommentItems(fixture.roots)).records
      .filter((item: any) => item.record.schema === "fyow.snapshot/3");
    const published = snapshots.at(-1).record;
    expect(published.ledgerCoverage.through.timestamp).toBe(base + 100);
    expect(published.state.claimedTreasures.old).toBeUndefined();
    expect(published.ledgerCoverage.treasureSources.old.retiredOrder.timestamp).toBeGreaterThan(base + 150);
    expect(author.applyMapDelta(missed)).toBe(true);
    expect(author.world.claimedTreasures.old.accountId).toBe("player");
    const reader = fixture.create("player");
    await reader.sync(true);
    expect(reader.world.claimedTreasures.old.accountId).toBe("player");
    expect(reader.world.cells["3,3"].ownerAccountId).toBe("player");
    expect(reader.world.cells["2,2"].ownerAccountId).toBe("author");
    expect(reader.world.generals.shared.name).toBe("较新");
    expect(reader.world.generals.remote.name).toBe("远端");
    expect(reader.world.treasureEpoch).toBe(2);
    expect(reader.world.treasureSpawns.old).toBeUndefined();
    const tooLate = map("player", 500, { claimedTreasures: missed.record.changes.claimedTreasures });
    expect(reader.validMapDelta(tooLate)).toBe(false);
  });

  it("syncs verifiable defender casualties from a lost player attack", () => {
    const fixture = coverageHarness();
    const target = { ownerAccountId: "author", soldiers: 30, generalIds: [] };
    fixture.author.world.cells["4,4"] = target;
    const losses = battleCasualties(20, 50, 10, target.soldiers);
    const battle = {
      battleId: "lost-attack-1",
      attackerAccountId: "player",
      targetOwnerAccountId: "author",
      outcome: "attacker-lost",
      x: 4,
      y: 4,
      beforeSoldiers: target.soldiers,
      afterSoldiers: losses.defenderSurvivors,
      attackerSoldiers: 10,
      defenderSoldiers: target.soldiers,
      attackerPower: 20,
      defenderPower: 50,
      attackerLosses: losses.attackerLosses,
      defenderLosses: losses.defenderLosses,
      attackerSurvivors: losses.attackerSurvivors,
      defenderSurvivors: losses.defenderSurvivors
    };
    const delta = fixture.map("player", 40, {
      cells: { "4,4": { ...target, soldiers: losses.defenderSurvivors } },
      battles: { [battle.battleId]: battle }
    });
    expect(fixture.author.validMapDelta(delta)).toBe(true);
    expect(fixture.author.applyMapDelta(delta)).toBe(true);
    expect(fixture.author.world.cells["4,4"].soldiers).toBe(losses.defenderSurvivors);

    fixture.author.world.cells["7,7"] = { ...target };
    const malformedBattle = { ...battle, battleId: "lost-attack-malformed", x: 7, y: 7, attackerSoldiers: "foo" };
    const malformed = fixture.map("player", 44, {
      cells: { "7,7": { ...target, soldiers: losses.defenderSurvivors } },
      battles: { [malformedBattle.battleId]: malformedBattle }
    });
    expect(fixture.author.validMapDelta(malformed)).toBe(false);

    const forgedBattle = fixture.map("player", 45, {
      cells: { "6,6": { ownerAccountId: "author", soldiers: 1, generalIds: [], defensivePower: 999999 } },
      battles: { [battle.battleId]: { ...battle, battleId: battle.battleId, x: 6, y: 6, beforeSoldiers: 30, afterSoldiers: 1, defenderSoldiers: 30 } }
    });
    fixture.author.world.cells["6,6"] = { ownerAccountId: "author", soldiers: 30, generalIds: [] };
    expect(fixture.author.validMapDelta(forgedBattle)).toBe(false);

    const forged = fixture.map("player", 50, {
      cells: { "5,5": { ownerAccountId: "author", soldiers: 1, generalIds: [] } }
    });
    fixture.author.world.cells["5,5"] = { ownerAccountId: "author", soldiers: 30, generalIds: [] };
    expect(fixture.author.validMapDelta(forged)).toBe(false);
  });

  it("grandfathers an existing over-cap garrison without allowing it to grow", () => {
    const fixture = coverageHarness();
    const x = 8;
    const y = 8;
    const cap = staticCell(fixture.author.world.seed, x, y).garrisonCap;
    const legacySoldiers = cap + 50;
    fixture.author.world.cells[`${x},${y}`] = { ownerAccountId: "player", soldiers: legacySoldiers, generalIds: [] };

    const unchanged = fixture.map("player", 60, {
      cells: { [`${x},${y}`]: { ownerAccountId: "player", soldiers: legacySoldiers, generalIds: [] } }
    });
    const reduced = fixture.map("player", 61, {
      cells: { [`${x},${y}`]: { ownerAccountId: "player", soldiers: legacySoldiers - 25, generalIds: [] } }
    });
    const increased = fixture.map("player", 62, {
      cells: { [`${x},${y}`]: { ownerAccountId: "player", soldiers: legacySoldiers + 1, generalIds: [] } }
    });
    const newOverCap = fixture.map("player", 63, {
      cells: { "9,8": { ownerAccountId: "player", soldiers: staticCell(fixture.author.world.seed, 9, 8).garrisonCap + 1, generalIds: [] } }
    });

    expect(fixture.author.validMapDelta(unchanged)).toBe(true);
    expect(fixture.author.validMapDelta(reduced)).toBe(true);
    expect(fixture.author.validMapDelta(increased)).toBe(false);
    expect(fixture.author.validMapDelta(newOverCap)).toBe(false);
  });

  it("persists occupation counts monotonically while replaying legacy zero-count records", async () => {
    const fixture = coverageHarness();
    fixture.author.world.cells["10,10"] = { ownerAccountId: "author", soldiers: 0, generalIds: [] };

    const legacyReplay = fixture.map("player", 70, {
      cells: { "10,10": { ownerAccountId: "player", soldiers: 0, generalIds: [] } }
    });
    expect(fixture.author.validMapDelta(legacyReplay)).toBe(true);
    fixture.author.control.occupationCountingProtocol = 1;
    fixture.author.controlPlatformOrder = { timestamp: fixture.base + 71, commentId: "cutover" };
    const postCutoverLegacyWrite = fixture.map("player", 71, {
      cells: { "10,10": { ownerAccountId: "player", soldiers: 0, generalIds: [] } }
    });
    expect(fixture.author.validMapDelta(postCutoverLegacyWrite)).toBe(true);
    delete fixture.author.control.occupationCountingProtocol;
    fixture.author.controlPlatformOrder = { timestamp: 0, commentId: "" };

    const firstTrackedTakeover = fixture.map("player", 71, {
      cells: { "10,10": { ownerAccountId: "player", soldiers: 0, generalIds: [], occupationCount: 1 } }
    });
    expect(fixture.author.validMapDelta(firstTrackedTakeover)).toBe(true);
    expect(fixture.author.applyMapDelta(firstTrackedTakeover)).toBe(true);
    expect(fixture.author.world.cells["10,10"].occupationCount).toBe(1);

    const sameOwnerIncrement = fixture.map("player", 72, {
      cells: { "10,10": { ownerAccountId: "player", soldiers: 0, generalIds: [], occupationCount: 2 } }
    });
    const countDroppingLegacyWrite = fixture.map("player", 73, {
      cells: { "10,10": { ownerAccountId: "player", soldiers: 0, generalIds: [] } }
    });
    const countedTombstone = fixture.map("player", 74, { cells: { "10,10": null } });
    expect(fixture.author.validMapDelta(sameOwnerIncrement)).toBe(false);
    expect(fixture.author.applyMapDelta(countDroppingLegacyWrite)).toBe(true);
    expect(fixture.author.world.cells["10,10"].occupationCount).toBe(1);
    expect(fixture.author.applyMapDelta(countedTombstone)).toBe(true);
    expect(fixture.author.world.cells["10,10"]).toMatchObject({ ownerAccountId: null, occupationCount: 1 });

    const secondTakeover = fixture.map("author", 75, {
      cells: { "10,10": { ownerAccountId: "author", soldiers: 0, generalIds: [], occupationCount: 2 } }
    });
    const skippedTakeover = fixture.map("author", 76, {
      cells: { "10,10": { ownerAccountId: "author", soldiers: 0, generalIds: [], occupationCount: 3 } }
    });
    expect(fixture.author.validMapDelta(secondTakeover)).toBe(true);
    expect(fixture.author.validMapDelta(skippedTakeover)).toBe(false);
    expect(fixture.author.applyMapDelta(secondTakeover)).toBe(true);

    const snapshot = await fixture.author.publishSnapshot();
    expect(snapshot.state.cells["10,10"].occupationCount).toBe(2);
  });

  it("rejects signed snapshots with malformed occupation counts while accepting legacy missing counts", () => {
    const fixture = coverageHarness();
    const legacyState = structuredClone(fixture.author.world);
    legacyState.cells["3,4"] = { ownerAccountId: "author", soldiers: 0, generalIds: [] };
    const legacySnapshot = fixture.snapshot(legacyState, 81);
    expect(fixture.author.verifiedSnapshots([legacySnapshot])).toHaveLength(1);

    const malformedState = structuredClone(legacyState);
    malformedState.cells["3,4"].occupationCount = -1;
    const malformedSnapshot = fixture.snapshot(malformedState, 82);
    expect(fixture.author.verifiedSnapshots([malformedSnapshot])).toEqual([]);
  });

  it("keeps occupation counts convergent when two players claim the same neutral base concurrently", () => {
    const fixture = coverageHarness();
    const key = "11,11";
    const baseWorld = structuredClone(fixture.author.world);
    fixture.author.control.occupationCountingProtocol = 1;
    fixture.author.controlPlatformOrder = { timestamp: fixture.base + 50, commentId: "control" };
    const baseOrder = { timestamp: 0, commentId: "" };
    const sidecar = { cell: null, nextOccupationCount: 1, order: baseOrder };
    const early = fixture.map("player", 90, {
      cells: { [key]: { ownerAccountId: "player", soldiers: 0, generalIds: [] } },
      cellBases: { [key]: sidecar }
    });
    const late = fixture.map("author", 91, {
      cells: { [key]: { ownerAccountId: "author", soldiers: 0, generalIds: [] } },
      cellBases: { [key]: sidecar }
    });

    expect(Object.keys(early.record.changes.cells[key]).sort()).toEqual(["generalIds", "ownerAccountId", "soldiers"]);
    expect(fixture.author.applyMapDelta(early)).toBe(true);
    expect(fixture.author.applyMapDelta(late)).toBe(true);
    expect(fixture.author.world.cells[key]).toMatchObject({ ownerAccountId: "author", occupationCount: 1 });

    const optimistic = fixture.create("author");
    optimistic.control = fixture.author.control;
    optimistic.controlPlatformOrder = fixture.author.controlPlatformOrder;
    optimistic.world = baseWorld;
    optimistic.world.cells[key] = { ownerAccountId: "author", soldiers: 0, generalIds: [], occupationCount: 1 };
    const lateOrder = recordPlatformOrder(late);
    optimistic.publicCellOrders[key] = lateOrder;
    optimistic.publicCellWriteBases[key] = {
      order: baseOrder,
      hash: sha256(Buffer.from(canonicalJson(null)))
    };
    optimistic.appliedMapDeltaIds.add(late.record.mapDeltaId);
    expect(optimistic.applyMapDelta(early)).toBe(true);
    expect(optimistic.world.cells[key]).toMatchObject({ ownerAccountId: "author", occupationCount: 1 });
  });

  it("holds snapshot coverage before an incomplete root and replays it after late replies arrive", async () => {
    const fixture = coverageHarness();
    const pending = fixture.map("player", 150, {
      cells: { "9,9": { ownerAccountId: "player", soldiers: 10, generalIds: [] } }
    }, { padding: crypto.randomBytes(2500).toString("hex") });
    const replies = pending.root.children;
    expect(replies.length).toBeGreaterThan(1);
    pending.root.children = [];
    fixture.append({ schema: "fyow.event/3", eventId: "after-pending" }, "author", fixture.base + 190);
    await fixture.author.sync(true);
    expect(fixture.author.history.incomplete).toBeGreaterThan(0);
    expect(fixture.author.publicHistoryOrder.timestamp).toBe(fixture.base + 149);
    const published = await fixture.author.publishSnapshot();
    expect(published.ledgerCoverage.through.timestamp).toBe(fixture.base + 149);
    expect(published.state.cells["9,9"]).toBeUndefined();
    pending.root.children = replies.map((reply: any) => ({ ...reply, created_at: fixture.base + 500 }));
    const reader = fixture.create("player");
    await reader.sync(true);
    expect(reader.history.incomplete).toBe(0);
    expect(reader.world.cells["9,9"].ownerAccountId).toBe("player");
  });

  it("reads older pages down to signed coverage instead of stopping at the snapshot's publication page", async () => {
    const fixture = coverageHarness();
    const ordinary = (time: number) => fixture.roots.push({ id: `ordinary-${time}`, account_id: "author", content: "普通评论", created_at: fixture.base + time, children: [] });
    for (let time = 11; time < 110; time += 1) ordinary(time);
    fixture.map("player", 150, { cells: { "7,7": { ownerAccountId: "player", soldiers: 10, generalIds: [] } } });
    for (let time = 151; time <= 250; time += 1) ordinary(time);
    fixture.snapshot(fixture.author.world, 300, { version: 1, through: { timestamp: fixture.base + 100, commentId: "" } });
    fixture.append(signRecord({ ...fixture.author.control, id: "new-control" }, fixture.identities.author.signingPrivateKey), "author", fixture.base + 301);
    const reader = fixture.create("player");
    await reader.sync(true);
    expect(reader.history.tailPage).toBe(5);
    expect(reader.history.stoppedBy).toBe("oldest-page");
    expect(reader.world.cells["7,7"].ownerAccountId).toBe("player");
    expect(reader.publicMapBaselineOrder.timestamp).toBe(fixture.base + 100);
  });

  it("replays legacy snapshots conservatively without resurrecting pre-reset data or resetting the new player again", async () => {
    const fixture = coverageHarness();
    fixture.map("player", 50, { cells: { "4,4": { ownerAccountId: "player", soldiers: 10, generalIds: [] } } });
    fixture.append(signRecord({
      schema: "fyow.authority/1", authorityId: "old-reset", gameId: fixture.author.world.gameId,
      workId: "work", seasonId: "season", authorityAccountId: "author", type: "player-reset", targetAccountId: "player", playerEpoch: 1
    }, fixture.identities.author.signingPrivateKey), "author", fixture.base + 70);
    const resetState = JSON.parse(JSON.stringify(fixture.author.world));
    resetState.playerEpochs.player = 1;
    fixture.snapshot(resetState, 100);
    fixture.map("player", 110, { cells: { "5,5": { ownerAccountId: "player", soldiers: 10, generalIds: [] } } }, { playerEpoch: 1 });
    const reader = fixture.create("player");
    await reader.sync(true);
    expect(reader.publicMapBaselineOrder.timestamp).toBe(0);
    expect(reader.world.playerEpochs.player).toBe(1);
    expect(reader.world.cells["4,4"]).toBeUndefined();
    expect(reader.world.cells["5,5"].ownerAccountId).toBe("player");
    expect(reader.world.players.player).toBeTruthy();
    await reader.sync(true);
    expect(reader.world.playerEpochs.player).toBe(1);
    expect(reader.world.cells["5,5"].ownerAccountId).toBe("player");
  });

  it("serializes player actions so two different clicks cannot mutate the world concurrently", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const instance = service({ getAccount: () => ({ accountId: "player", username: "玩家" }) });
    instance.submitIntentNow = async (intent: any) => {
      if (intent.type === "first") await gate;
      return { type: intent.type };
    };
    const first = instance.submitIntent({ type: "first", idempotencyKey: "first" });
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(instance.submitIntent({ type: "second", idempotencyKey: "second" })).rejects.toThrow(/上一项行动/);
    release();
    await expect(first).resolves.toEqual({ type: "first" });
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

  it("rejects entry during a platform 503 while preserving the owner's private archive", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-offline-open-"));
    const cacheFile = path.join(directory, "cache.json");
    const card = createBundledGridCard();
    const accountId = card.companion.authorAccountId;
    const identity = generateOnlineWorldIdentity();
    const diagnostics: any[] = [];
    const seed = service({
      cacheFile,
      getAccount: () => ({ accountId, username: "服主" }),
      getIdentity: async () => identity
    });
    seed.card = card;
    seed.work = { id: card.companion.workId, name: card.companion.name, authorAccountId: accountId };
    seed.control = signRecord({
      schema: "fyow.control/3",
      id: "cached-control",
      gameId: card.gameId,
      workId: card.companion.workId,
      seasonId: "cached-season",
      programHash: seed.currentProgramHash(),
      authorityAccountId: accountId,
      authoritySigningPublicKey: identity.signingPublicKey,
      authorityEncryptionPublicKey: identity.encryptionPublicKey,
      startedAt: 1_800_000_000_000
    }, identity.signingPrivateKey);
    seed.world = createWorld({
      seed: "cached-world",
      seasonId: "cached-season",
      authorityAccountId: accountId,
      startedAt: 1_800_000_000_000
    });
    seed.world.players[accountId] = {
      accountId,
      displayName: "服主",
      position: { x: 2, y: 2 },
      carriedGeneralIds: []
    };
    seed.world.privatePlayers[accountId] = { orientation: "any" };
    seed.saveCache();
    seed.close();

    const offline = service({
      cacheFile,
      getAccount: () => ({ accountId, username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async () => { throw new Error("平台请求失败：503"); },
      onDiagnostic: (detail: any) => diagnostics.push(detail)
    });
    try {
      await expect(offline.open({ card, displayName: "服主", orientation: "any" })).rejects.toThrow("503");
      expect(offline.state()).toMatchObject({
        initialized: true,
        isAuthor: true,
        isServerOwner: true,
        status: "degraded",
        error: "平台请求失败：503",
        loadProgress: { active: true, phase: "error" },
        work: { id: card.companion.workId, authorAccountId: accountId }
      });
      expect(offline.world.players[accountId].position).toEqual({ x: 2, y: 2 });
      expect(await offline.isGameCardAuthor(card)).toBe(true);
      expect(diagnostics.map(item => item.event)).toEqual(expect.arrayContaining([
        "work-detail-cache-fallback",
        "sync-failed",
        "card-author-cache-fallback"
      ]));
    } finally {
      offline.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
    expect(state.isServerOwner).toBe(false);
    await expect(instance.initialize()).rejects.toThrow(/只有作品作者/);
  });

  it("loads and stores the current companion-page program for guests and authors through the same endpoint", async () => {
    const originalCard = createBundledGridCard();
    const currentWorkId = "b27218e6-80f9-4c0d-91c7-4b8f87d47be8";
    const cards = [originalCard, rebindGameCard(originalCard, currentWorkId, originalCard.companion.origin)];
    const latest = packProgram({ gameId: originalCard.gameId, title: "公开新版", html: "<!doctype html><html><body>public latest</body></html>" });
    for (const [index, card] of cards.entries()) {
      const consoleEndpoints: string[] = [];
      const goEndpoints: string[] = [];
      const accountId = index === 0 ? "player" : card.companion.authorAccountId;
      const instance = service({
        getAccount: () => ({ accountId, username: index === 0 ? "玩家" : "服主" }),
        requestConsole: async (endpoint: string) => {
          consoleEndpoints.push(endpoint);
          if (endpoint.startsWith("/installed-apps/")) return {
            data: {
              id: card.companion.workId,
              created_by_account_id: card.companion.authorAccountId,
              app: { id: card.companion.workId, name: "猎艳疆土" }
            }
          };
          return { data: { items: [] } };
        },
        requestGo: async (endpoint: string) => {
          goEndpoints.push(endpoint);
          return { data: { apps: { id: card.companion.workId, description: latest.envelope } } };
        }
      });
      const state = await instance.open({ card, displayName: "玩家", orientation: "any" });
      instance.close();
      expect(state.program).toMatchObject({ source: "work-description", digest: latest.digest, title: "公开新版" });
      expect(instance.card?.program.digest).toBe(latest.digest);
      expect(instance.card?.companion.configuration.app.description).toBe(latest.envelope);
      expect(consoleEndpoints.some(endpoint => endpoint.includes("/model-config/export"))).toBe(false);
      expect(goEndpoints).toEqual([`/apps/${card.companion.workId}`]);
      expect(goEndpoints.some(endpoint => endpoint.startsWith("/apps/config?"))).toBe(false);
    }
  });

  it("loads a live companion program using each card's own game id", () => {
    const original = createBundledGridCard();
    const gameId = "community.example.other-game";
    const localProgram = packProgram({ gameId, title: "其他游戏", html: "<!doctype html><html><body>local</body></html>" });
    const card: any = JSON.parse(JSON.stringify(original));
    card.cardId = "community.example.other-game.official";
    card.gameId = gameId;
    card.title = "其他游戏";
    card.companion.configuration.app.description = localProgram.envelope;
    card.program = { format: "fyow.program/1", apiVersion: 1, digest: localProgram.digest };
    card.companion.configurationSha256 = configurationDigest(card.companion.configuration);
    card.packageSha256 = cardDigest(card);
    const latest = packProgram({ gameId, title: "其他游戏新版", html: "<!doctype html><html><body>latest</body></html>" });
    const instance = service({});
    const loaded = instance.loadWorkProgram(card, latest.envelope);
    expect(loaded).toMatchObject({
      source: "work-description",
      digest: latest.digest,
      manifest: { title: "其他游戏新版", gameId }
    });
    expect(instance.card.program.digest).toBe(latest.digest);
  });

  it("keeps the signed card program when the current companion page has no valid program", async () => {
    const card = createBundledGridCard();
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      requestConsole: async (endpoint: string) => endpoint.startsWith("/installed-apps/")
        ? { data: { id: card.companion.workId, created_by_account_id: card.companion.authorAccountId } }
        : { data: { items: [] } },
      requestGo: async () => ({ data: { apps: { id: card.companion.workId, description: "普通作品介绍" } } })
    });
    const state = await instance.open({ card, displayName: "玩家", orientation: "any" });
    instance.close();
    expect(state.program).toMatchObject({ source: "card-package", digest: card.program.digest });
    expect(instance.card?.packageSha256).toBe(card.packageSha256);
  });

  it("rejects a changed platform author on refresh before writing any comments", async () => {
    const fixture = coverageHarness();
    const instance = fixture.author;
    instance.card = { companion: { authorAccountId: "author" } };
    let posts = 0;
    instance.requestConsole = async (_endpoint: string, options: any = {}) => {
      if (options.method === "POST") posts += 1;
      return { id: "work", created_by_account_id: "replacement-author" };
    };
    await expect(instance.refreshWorkProgram()).rejects.toThrow(/作品作者已变更/);
    expect(instance.work.authorAccountId).toBe("author");
    expect(posts).toBe(0);
  });

  it("loads the current work-description program for every player without a publication gate", async () => {
    const fixture = coverageHarness();
    const program = packProgram({ gameId: fixture.author.world.gameId, title: "新版", html: "<!doctype html><html><body>updated</body></html>" });
    const owner = fixture.author;
    const requestComments = owner.requestConsole;
    const requestConsole = async (endpoint: string, options: any = {}) => endpoint.startsWith("/installed-apps/")
      ? { id: "work", created_by_account_id: "author", description: program.envelope }
      : requestComments(endpoint, options);
    owner.requestConsole = requestConsole;
    owner.requestGo = async () => ({ data: { apps: { id: "work", description: program.envelope } } });
    const guest = fixture.create("player");
    guest.requestConsole = requestConsole;
    guest.requestGo = owner.requestGo;
    let modelCalls = 0;
    owner.requestModel = async () => { modelCalls += 1; throw new Error("unexpected model request"); };
    // Reflect a newly downloaded description while the comment control still names the previous package.
    await owner.refreshWorkProgram();
    await guest.refreshWorkProgram();
    const state = await owner.sync(true);
    expect(state.status).toBe("ready");
    expect(state.isServerOwner).toBe(true);
    expect(state.program.source).toBe("work-description");
    expect(state.program.digest).toBe(program.digest);
    expect(owner.world).toMatchObject({ seasonId: "season", seed: "coverage", treasureEpoch: 1 });
    expect(modelCalls).toBe(0);
    await expect(owner.initialize()).rejects.toThrow(/已经开服/);
    const readyGuest = await guest.sync(true);
    expect(readyGuest.status).toBe("ready");
    expect(readyGuest.program.source).toBe("work-description");
    expect(readyGuest.program.digest).toBe(program.digest);
    expect(readyGuest.isServerOwner).toBe(false);
    expect(owner.world).toMatchObject({ seasonId: "season", seed: "coverage", treasureEpoch: 1 });
    expect(owner.world.treasureSpawns.old).toBeTruthy();
    expect(guest.world.seasonId).toBe("season");
    expect(guest.control.programHash).not.toBe(program.digest);
  });

  it("keeps author and synchronization controls outside the multi-game library", () => {
    const renderer = fs.readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const library = fs.readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const game = fs.readFileSync(new URL("../electron/desktop/online-world/grid-conquest/index.html", import.meta.url), "utf8");
    expect(library).not.toMatch(/id="online-world-(?:initialize|activate-program|migrate|status)"/);
    expect(library).not.toContain('id="online-world-export-card"');
    expect(game).not.toContain('id="owner-publish-program"');
    expect(game).not.toContain("发布游戏更新");
    expect(renderer).not.toContain("正在同步评论账本");
    expect(renderer).not.toContain("wasInitialized");
    expect(renderer).not.toContain('command.type==="publish-program"');
    expect(renderer).toContain("selectedActiveCard");
    expect(renderer).toContain("card.isCurrentUserAuthor");
    expect(renderer).toContain("api.exportOnlineWorldCard(libraryId)");
    expect(renderer).toContain("onlineWorldClosePromise=api.closeOnlineWorld()");
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
      },
      requestGo: async (endpoint: string) => endpoint === "/apps/4ac2ab60-67ff-459d-ae9a-6274f1802195"
        ? { data: { apps: { id: "4ac2ab60-67ff-459d-ae9a-6274f1802195", description: program.envelope } } }
        : { data: {} }
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
    const modelRequests: any[] = [];
    const platformTime = Date.parse("2026-09-13T05:10:20.000Z");
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestModel: async (request: any) => {
        modelRequests.push(request);
        return { conversationId: `join-preview-${modelRequests.length}`, answer: JSON.stringify(completeGeneral) };
      },
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

    const previewIntent = {
      type: "prepare-join", displayName: "服主", orientation: "women", characterProfileId: "profile-author",
      characterProfile: { id: "profile-author", displayName: "服主", basicInfo: "猫亚人", appearance: "白色头发" },
      characterTags: ["傲娇", "勇敢", "冷静", "长发", "黑发", "红瞳", "高挑", "军装"],
      initialGeneralWish: "furry", idempotencyKey: "preview-author"
    };
    const firstPreview = await instance.submitIntent(previewIntent);
    expect(instance.world.players.author).toBeUndefined();
    const preview = await instance.submitIntent({ ...previewIntent, idempotencyKey: "preview-author-reroll" });
    expect(preview.joinPreview.previewId).not.toBe(firstPreview.joinPreview.previewId);
    expect(instance.world.players.author).toBeUndefined();
    const joinIntent = { type: "join", previewId: preview.joinPreview.previewId, initialGeneral: { ...preview.joinPreview.general, coreSetting: "由玩家在确认前自由改写的初始设定。" }, idempotencyKey: "join-author" };
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
    expect((Object.values(instance.world.generals)[0] as any).power).toBe(preview.joinPreview.general.power);
    expect((Object.values(instance.world.generals)[0] as any).coreSetting).toBe("由玩家在确认前自由改写的初始设定。");
    expect(instance.localPreferences.playerContext).toMatchObject({
      personaSummary: "猫亚人",
      appearanceSummary: "白色头发",
      speechStyle: "",
      relationshipApproach: ""
    });
    expect(modelRequests.map(request => request.task)).toEqual(["general.generate", "general.generate"]);
    expect(modelRequests.every(request => request.input.initialWish === "furry")).toBe(true);
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

  it("preserves a valid local retreat path when a public snapshot replaces the world", () => {
    const now = 1_000_000;
    const instance = service({ getAccount: () => ({ accountId: "author", username: "服主" }) });
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: now });
    instance.world.players.author = {
      accountId: "author", displayName: "服主", gold: 500, fieldArmySoldiers: 0,
      carriedGeneralIds: [], position: { x: 9, y: 9 },
      retreatPath: [{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }]
    };

    const overlay = instance.captureLocalOverlay();
    expect(overlay.players.author.retreatPath).toEqual([
      { x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }
    ]);

    const replacement = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: now });
    replacement.players.author = {
      accountId: "author", displayName: "服主", position: { x: 9, y: 9 }, carriedGeneralIds: []
    };
    instance.world = replacement;
    instance.restoreLocalOverlay(overlay);
    expect(instance.world.players.author.retreatPath).toEqual([
      { x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }
    ]);

    instance.world.players.author.retreatPath = [{ x: 9, y: 9 }, { x: 7, y: 9 }];
    expect(instance.captureLocalOverlay().players.author).not.toHaveProperty("retreatPath");
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
        if (request.task === "general.dialogue") return { conversationId: "conversation-dialogue", answer: '```json\n{"reply":"愿与主公谈谈北境。","narration":"她抬手按住地图边角，目光落向北方。","command":null,"memoryUpdate":{"category":"speech","summary":"与主公甲谈论北境","emotion":"振奋","intimacyDelta":2,"compactMemory":"言谈：[1年]与主公甲谈论北境，感到振奋。\\n经历：[1年]被主公甲发掘并提拔为将领"}}\n```' };
        throw new Error(`unexpected task ${request.task}`);
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = world;
    instance.localPreferences.characterProfileId = "profile-a";
    instance.localPreferences.playerContext = { displayName: "主公甲", personaSummary: "慧眼之主", appearanceSummary: "", speechStyle: "沉稳", relationshipApproach: "重视忠诚" };
    const result = await instance.submitIntent({ type: "talk-general", generalId: "g1", topic: "北境局势", idempotencyKey: "talk" });
    expect(requestedTasks).toEqual(["general.dialogue"]);
    expect(result.dialogue.memory).toMatchObject({ category: "speech", intimacyDelta: 2 });
    expect(result.dialogue.narration).toContain("地图");
    expect(instance.world.generals.g1.memoryText).toContain("与主公甲谈论北境");
    expect(instance.world.generals.g1.interactionHistory.at(-1)).toMatchObject({ category: "speech", emotion: "振奋" });
    expect(result.state.world.generals.g1.interactionHistory.at(-1)).toMatchObject({ userText: "北境局势", reply: "愿与主公谈谈北境。" });
  });

  it("publishes one public general update for a deployed-general interaction", async () => {
    const now = 1_000_000;
    const identity = generateOnlineWorldIdentity();
    let world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: now });
    world = require("../electron/grid-world-game.cjs").applyIntent(world, {
      type: "join", displayName: "主公甲", orientation: "women", characterProfileId: "profile-a",
      characterTags: ["沉稳"], initialGeneralWish: "良将", playerContext: { personaSummary: completePersona }, idempotencyKey: "join"
    }, { actorAccountId: "author", now }).state;
    world = require("../electron/grid-world-game.cjs").applyIntent(world, {
      type: "grant-general", generalId: "g1", name: "青禾", gender: "female", appearanceSetting: completeGeneralAppearance,
      coreSetting: completeGeneralSetting.slice(0, 700), power: 320, discoveryId: "grant", idempotencyKey: "grant"
    }, { actorAccountId: "author", authorityAccountId: "author", now }).state;
    world = require("../electron/grid-world-game.cjs").applyIntent(world, {
      type: "deploy-general", generalId: "g1", idempotencyKey: "deploy"
    }, { actorAccountId: "author", now: now + 1 }).state;
    const comments: any[] = [];
    const instance = service({
      now: () => now + 20_000,
      getAccount: () => ({ accountId: "author", username: "服主昵称" }),
      getIdentity: async () => identity,
      requestConsole: async (_endpoint: string, options: any = {}) => {
        const item = { id: `comment-${comments.length + 1}`, account_id: "author", created_at: now + 30_000 + comments.length, content: options.body.content };
        comments.push(item);
        return item;
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = world;
    instance.localPreferences.playerContext = { displayName: "主公甲", personaSummary: completePersona, appearanceSummary: completeAppearance, speechStyle: completeSpeech, relationshipApproach: completeRelationship };
    await instance.submitIntent({ type: "talk-general", generalId: "g1", topic: "北境局势", idempotencyKey: "talk-deployed" });
    const records = assembleCommentRecords(comments).records.map((item: any) => item.record);
    expect(records.filter((record: any) => record.schema === "fyow.map-delta/1")).toHaveLength(1);
    expect(instance.world.generals.g1.memoryText).toContain("言谈：");
  });

  it("does not commit a new player while initial-general preview generation has not produced JSON", async () => {
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
      type: "prepare-join", displayName: "服主", orientation: "women", characterProfileId: "profile-author",
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
    const control = { id: "control-current", seasonId: world.seasonId, startedAt: world.startedAt, authorityAccountId: "authority" };
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
    expect(sender.directHistory[0]).toMatchObject({ workId: "work", seasonId: world.seasonId, controlId: "control-current" });

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
    receiver.directReceiveTimes.set("sender", Array(20).fill(receiver.now()));
    expect(await receiver.receiveDirectWakes()).toHaveLength(0);
    expect(receiver.seenDirectMessageIds.has(sent.messageId)).toBe(false);
    receiver.directReceiveTimes.clear();
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
    instance.control = { id: "control-current", seasonId: world.seasonId, startedAt: world.startedAt, authorityAccountId: "authority" };
    instance.world = world;
    const base = { schema: "fyow.map-delta/1", mapDeltaId: "foreign", seasonId: world.seasonId, actorAccountId: "player", participant: { displayName: "串局玩家" }, changes: { cells: { "1,1": { ownerAccountId: "player", soldiers: 1, generalIds: [] } }, generals: {} }, deviceSigningPublicKey: playerIdentity.signingPublicKey, deviceEncryptionPublicKey: playerIdentity.encryptionPublicKey };
    const foreignWork = signRecord({ ...base, workId: "another-work", gameId: "cc.aiero.fyow.grid-conquest" }, playerIdentity.signingPrivateKey);
    const foreignGame = signRecord({ ...base, mapDeltaId: "foreign-game", workId: "current-work", gameId: "another-game" }, playerIdentity.signingPrivateKey);
    instance.applyMapDeltas([{ record: foreignWork, sources: [{ id: "f1", account_id: "player", created_at: "2026-09-13T01:00:00Z" }] }, { record: foreignGame, sources: [{ id: "f2", account_id: "player", created_at: "2026-09-13T01:00:01Z" }] }]);
    expect(instance.world.cells["1,1"]).toBeUndefined();
    expect(instance.world.revision).toBe(0);
  });

  it("summarizes invalid historical map records instead of logging every record", () => {
    const diagnostics: any[] = [];
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season" });
    const instance = service({
      getAccount: () => ({ accountId: "authority", username: "服主" }),
      onDiagnostic: (detail: any) => diagnostics.push(detail)
    });
    instance.work = { id: "current-work", authorAccountId: "authority" };
    instance.control = { id: "control", seasonId: world.seasonId, authorityAccountId: "authority" };
    instance.world = world;
    const invalid = (mapDeltaId: string, index: number) => ({
      record: {
        schema: "fyow.map-delta/1", mapDeltaId, workId: "current-work", gameId: "cc.aiero.fyow.grid-conquest",
        seasonId: world.seasonId, actorAccountId: "player", changes: { cells: { [`${index},${index}`]: null }, generals: {} }
      },
      sources: [{ id: `comment-${index}`, account_id: "player", created_at: `2026-09-25T00:00:0${index}Z` }]
    });

    expect(instance.applyMapDeltas([invalid("bad-1", 1), invalid("bad-2", 2), invalid("bad-3", 3)])).toBe(0);
    expect(diagnostics.filter(item => item.event === "map-delta-rejected")).toHaveLength(0);
    expect(diagnostics.filter(item => item.event === "map-delta-rejected-summary")).toEqual([
      expect.objectContaining({ code: "FYOW_MAP_DELTA_INVALID", count: 3, sampleMapDeltaIds: ["bad-1", "bad-2", "bad-3"] })
    ]);

    instance.applyMapDeltas([invalid("bad-1", 1), invalid("bad-2", 2), invalid("bad-3", 3)]);
    expect(diagnostics.filter(item => item.event === "map-delta-rejected-summary")).toHaveLength(1);
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

  it("rolls back a public action when its map record was not fully posted", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season" });
    world.players.player = { accountId: "player", displayName: "玩家", gold: 1000, fieldArmySoldiers: 0, carriedGeneralIds: ["g1"], position: { x: 1, y: 1 } };
    world.privatePlayers.player = { orientation: "any" };
    world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    world.generals.g1 = createFallbackGeneral({ id: "g1", name: "试将", gender: "female", holderAccountId: "player", holderName: "玩家", power: 300 });
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      requestConsole: async () => {
        throw Object.assign(new Error("invalid deployment payload"), { code: "PLATFORM_HTTP", status: 400 });
      }
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;
    await expect(instance.submitIntent({ type: "deploy-general", generalId: "g1", idempotencyKey: "deploy" })).rejects.toThrow(/invalid deployment payload/);
    expect(instance.world.generals.g1.status).toBe("carried");
    expect(instance.world.players.player.carriedGeneralIds).toEqual(["g1"]);
    expect(instance.world.cells["1,1"].generalIds).toEqual([]);
    expect(instance.localEvents).toHaveLength(0);
    expect(instance.cloudUploadQueue).toHaveLength(0);
  });

  it("does not let a deletion safety rejection block the next durable cloud write", async () => {
    const deletionError = Object.assign(new Error("评论上下文已变化，保留原数据"), {
      code: "PLATFORM_DELETE_CONTEXT_CHANGED"
    });
    const deleteMany = vi.fn(async () => { throw deletionError; });
    const sent: string[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      commentOperations: { publish: vi.fn(), deleteMany },
      requestConsole: async (_endpoint: string, options: any = {}) => {
        sent.push(String(options.body?.content || ""));
        return { id: `chat-${sent.length}` };
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });

    const deletion = instance.enqueueCloudUpload({
      kind: "delete", key: "delete:changed", workId: "work",
      sources: [{ id: "obsolete", account_id: "player", parent_id: "root" }],
      knownOwnedCommentIds: ["obsolete"]
    });
    const message = instance.enqueueCloudUpload({
      kind: "chat-messages", key: "chat:after-delete", chatId: "chat", contents: ["still-sent"]
    });
    await expect(deletion).rejects.toBe(deletionError);
    await expect(message).resolves.toMatchObject({ sent: true });
    expect(sent).toEqual(["still-sent"]);
    expect(instance.cloudUploadQueue).toHaveLength(0);
    expect(instance.cloudUploadDeferred).toEqual([expect.objectContaining({
      key: "delete:changed",
      lastError: expect.objectContaining({ code: "PLATFORM_DELETE_CONTEXT_CHANGED" })
    })]);
  });

  it.each([
    { label: "deployment", intent: { type: "deploy-general", generalId: "g1", idempotencyKey: "deploy-rate-limited" }, initialStatus: "carried", expectedStatus: "deployed" },
    { label: "recall", intent: { type: "recall-general", generalId: "g1", idempotencyKey: "recall-rate-limited" }, initialStatus: "deployed", expectedStatus: "carried" }
  ])("keeps a $label locally and resumes the same signed publication after platform throttling", async ({ intent, initialStatus, expectedStatus }) => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season", startedAt: 1_000_000 });
    world.players.player = {
      accountId: "player", displayName: "玩家", gold: 1000, fieldArmySoldiers: 0,
      carriedGeneralIds: initialStatus === "carried" ? ["g1"] : [], position: { x: 1, y: 1 }
    };
    world.privatePlayers.player = { orientation: "any" };
    world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: initialStatus === "deployed" ? ["g1"] : [] };
    world.generals.g1 = createFallbackGeneral({ id: "g1", name: "试将", gender: "female", holderAccountId: "player", holderName: "玩家", power: 300 });
    world.generals.g1.status = initialStatus;
    world.generals.g1.location = initialStatus === "deployed" ? { x: 1, y: 1 } : null;
    let throttled = true;
    let posted = 0;
    let now = 2_000_000;
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      requestConsole: async (_endpoint: string, options: any = {}) => {
        if (throttled) throw Object.assign(new Error("请求过于频繁，请稍后"), {
          code: "PLATFORM_RATE_LIMIT", status: 429, httpStatus: 400, retryAfterMs: 30000
        });
        posted += 1;
        return { id: `published-${posted}`, account_id: "player", created_at: 2_000_000 + posted, ...options.body };
      },
      now: () => now
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;

    const result = await instance.submitIntent(intent);
    expect(result).toMatchObject({ pendingSync: true, pendingSyncMessage: "行动已保存在本机，正在等待平台同步" });
    expect(instance.world.generals.g1.status).toBe(expectedStatus);
    expect(instance.localEvents).toHaveLength(1);
    expect(instance.pendingIntentTransaction).toMatchObject({ phase: "prepared", intentType: intent.type });
    expect(instance.pendingIntentTransaction.lastPublishError).toMatchObject({ code: "PLATFORM_RATE_LIMIT", status: 429 });
    const transactionId = instance.pendingIntentTransaction.transactionId;
    const mapDeltaId = instance.pendingIntentTransaction.mapDeltaId;

    throttled = false;
    await expect(instance.retryPendingIntentTransactionPublish()).rejects.toMatchObject({
      code: "FYOW_PUBLICATION_COOLDOWN", status: 429
    });
    expect(posted).toBe(0);
    now = Math.max(
      now + 30_001,
      Number(instance.pendingIntentTransaction.lastPublishError?.retryAt || 0) + 1,
      Number(instance.cloudUploadQueue[0]?.nextAttemptAt || 0) + 1
    );
    await instance.retryPendingIntentTransactionPublish();
    expect(instance.pendingIntentTransaction).toMatchObject({ transactionId, mapDeltaId, phase: "published" });
    expect(posted).toBeGreaterThan(0);
    expect(instance.resolvePendingIntentTransaction()).toBe(true);
    expect(instance.pendingIntentTransaction).toBeNull();
    expect(instance.world.generals.g1.status).toBe(expectedStatus);
    expect(instance.localEvents).toHaveLength(1);
    expect(instance.pendingCommentRetirements).toHaveLength(intent.type === "recall-general" ? 1 : 0);
  });

  it.each([
    { label: "deployment", intentType: "deploy-general", initialStatus: "carried", remoteGeneralPresent: false },
    { label: "recall", intentType: "recall-general", initialStatus: "deployed", remoteGeneralPresent: true }
  ])("replays a newer cloud cell before cancelling a stale pending $label", async ({ intentType, initialStatus, remoteGeneralPresent }) => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season", startedAt: 1_000_000 });
    const baseGeneralIds = remoteGeneralPresent ? ["g1"] : [];
    world.players.player = {
      accountId: "player", displayName: "玩家", gold: 1000, fieldArmySoldiers: 0,
      carriedGeneralIds: initialStatus === "carried" ? ["g1"] : [], position: { x: 1, y: 1 }
    };
    world.privatePlayers.player = { orientation: "any" };
    world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: baseGeneralIds };
    world.generals.g1 = createFallbackGeneral({ id: "g1", name: "试将", gender: "female", holderAccountId: "player", holderName: "玩家", power: 300 });
    world.generals.g1.status = initialStatus;
    world.generals.g1.location = initialStatus === "deployed" ? { x: 1, y: 1 } : null;
    let posts = 0;
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      requestConsole: async () => {
        posts += 1;
        throw Object.assign(new Error("请求过于频繁，请稍后"), { code: "PLATFORM_RATE_LIMIT", status: 429 });
      },
      now: () => 2_000_000
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;
    const pending = await instance.submitIntent({ type: intentType, generalId: "g1", idempotencyKey: `stale-${intentType}` });
    expect(pending.pendingSync).toBe(true);
    const eventId = instance.pendingIntentTransaction.eventId;

    const baseCell = { ownerAccountId: "player", soldiers: 10, generalIds: baseGeneralIds, occupationCount: 0 };
    const remoteRecord = signRecord({
      schema: "fyow.map-delta/1", mapDeltaId: `remote-${intentType}`,
      gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season",
      actorAccountId: "player", participant: { displayName: "玩家" }, playerEpoch: 0,
      changes: {
        cells: { "1,1": { ownerAccountId: "player", soldiers: 20, generalIds: baseGeneralIds } },
        cellBases: { "1,1": { cell: baseCell, nextOccupationCount: 0, order: { timestamp: 0, commentId: "" } } },
        generals: {}, generalTransitions: {}
      },
      deviceSigningPublicKey: identity.signingPublicKey,
      deviceEncryptionPublicKey: identity.encryptionPublicKey
    }, identity.signingPrivateKey);
    const remoteItem = {
      record: remoteRecord,
      sources: [{ id: `remote-comment-${intentType}`, account_id: "player", created_at: 2_000_100 }]
    };
    instance.calibrateClock = vi.fn(async () => null);
    instance.readHistory = vi.fn(async () => ({ comments: remoteItem.sources, assembled: { records: [remoteItem] } }));
    instance.readWorldChatHistory = vi.fn(async () => ({ assembled: { records: [] } }));
    instance.receiveDirectWakes = vi.fn(async () => []);

    const synced = await instance.sync();
    expect(synced.status).toBe("ready");
    expect(instance.pendingIntentTransaction).toBeNull();
    expect(instance.appliedMapDeltaIds).toContain(`remote-${intentType}`);
    expect(instance.world.cells["1,1"]).toMatchObject({ soldiers: 20, generalIds: baseGeneralIds });
    expect(instance.world.generals.g1).toMatchObject({ status: initialStatus });
    expect(instance.world.players.player.carriedGeneralIds).toEqual(initialStatus === "carried" ? ["g1"] : []);
    expect(instance.localEvents.some((event: any) => event.eventId === eventId)).toBe(false);
    expect(posts).toBe(1);
  });

  it("defers a failed confirmed general generation and retries it with the same discovery identity", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season" });
    world.players.player = { accountId: "player", displayName: "玩家", gold: 1000, fieldArmySoldiers: 0, carriedGeneralIds: [], position: { x: 1, y: 1 } };
    world.privatePlayers.player = { orientation: "any", characterTags: ["冷静"] };
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      requestModel: async () => { throw new Error("model temporarily unavailable"); }
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;
    const effect = { type: "general-generation-request", sourceId: "march-job", accountId: "player", x: 2, y: 2, gender: "female", directionTags: ["冷静"], initial: false, confirmed: true, population: 5000, resourceGrade: "A" };
    const deferred = await instance.handleEffects([effect], identity, { deferOnFailure: true });
    expect(deferred.deferred).toHaveLength(1);
    expect(instance.pendingModelEffects).toHaveLength(1);
    const discoveryKey = instance.pendingModelEffects[0].key;
    let sequence = 0;
    instance.requestModel = async () => ({ conversationId: `retry-conversation-${++sequence}`, answer: JSON.stringify(completeGeneral) });
    instance.pendingModelEffects[0].nextAttemptAt = 0;
    await expect(instance.retryPendingModelEffects()).resolves.toEqual([discoveryKey]);
    expect(instance.pendingModelEffects).toHaveLength(0);
    expect(Object.values(instance.world.generals)).toHaveLength(1);
    expect(instance.world.processedIntents).toContain(`general:${discoveryKey}`);
  });

  it("drops deferred model rewards after the player generation has been reset", async () => {
    const world = createWorld({ authorityAccountId: "authority", seasonId: "season" });
    world.players.player = { accountId: "player", displayName: "玩家", position: { x: 1, y: 1 }, carriedGeneralIds: [] };
    world.playerEpochs.player = 1;
    let requested = false;
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      requestModel: async () => { requested = true; return { conversationId: "should-not-run", answer: JSON.stringify(completeGeneral) }; }
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;
    instance.pendingModelEffects = [{
      key: "old-generation",
      playerEpoch: 0,
      attempts: 1,
      nextAttemptAt: 0,
      effect: { type: "general-generation-request", sourceId: "old-job", accountId: "player", x: 2, y: 2, gender: "female", initial: false }
    }];
    await expect(instance.retryPendingModelEffects()).resolves.toEqual([]);
    expect(requested).toBe(false);
    expect(instance.pendingModelEffects).toHaveLength(0);
  });

  it("lets only the companion author publish signed ban and reset directives", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    world.players.author = { accountId: "author", accountName: "author@example", displayName: "服主", gold: 1000, position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    world.players.target = { accountId: "target", accountName: "target@example", displayName: "目标", gold: 1000, position: { x: 2, y: 2 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    world.cells["2,2"] = { ownerAccountId: "target", soldiers: 10, generalIds: [] };
    const targetGeneral = createFallbackGeneral({ id: "target-general", name: "守将", gender: "female", power: 320, holderAccountId: "target", talentSeed: "admin-action" });
    targetGeneral.status = "deployed";
    targetGeneral.location = { x: 2, y: 2 };
    world.generals[targetGeneral.id] = targetGeneral;
    world.cells["2,2"].generalIds.push(targetGeneral.id);
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
    const simulated = await instance.administer({
      type: "simulate-player-intent", targetAccountId: "target",
      intent: { type: "recall-general", generalId: "target-general" }
    });
    expect(simulated.command).toMatchObject({ type: "simulate-player-intent", targetAccountId: "target", intent: { type: "recall-general", generalId: "target-general" } });
    expect(instance.world.generals["target-general"]).toBeUndefined();
    expect(instance.world.cells["2,2"].generalIds).not.toContain("target-general");
    expect(Object.values(instance.world.authorityPlayerActions)).toContainEqual(expect.objectContaining({ targetAccountId: "target" }));
    const targetInstance = service({ getAccount: () => ({ accountId: "target", username: "target@example" }) });
    targetInstance.work = instance.work;
    targetInstance.control = instance.control;
    targetInstance.world = structuredClone(instance.world);
    expect(targetInstance.applyAuthorityPlayerActions()).toBe(1);
    expect(targetInstance.world.generals["target-general"]).toMatchObject({ status: "carried", location: null, holderAccountId: "target" });
    expect(targetInstance.world.players.target.carriedGeneralIds).toContain("target-general");
    expect(targetInstance.applyAuthorityPlayerActions()).toBe(0);
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

  it("recovers a recalled general across the public-publish/local-cache crash window", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-intent-transaction-"));
    const cacheFile = path.join(directory, "cache.json");
    try {
      const makeInstance = () => {
        const instance = service({ cacheFile, getAccount: () => ({ accountId: "player", username: "player@example" }), now: () => 2_000_000 });
        instance.work = { id: "work", authorAccountId: "author" };
        instance.control = { seasonId: "season", authorityAccountId: "author" };
        return instance;
      };
      const before = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: 1_000_000 });
      before.players.player = { accountId: "player", displayName: "玩家", gold: 1000, position: { x: 2, y: 2 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
      before.privatePlayers.player = {};
      before.playerEpochs.player = 0;
      before.cells["2,2"] = { ownerAccountId: "player", soldiers: 10, generalIds: ["durable-general"] };
      const general = createFallbackGeneral({ id: "durable-general", name: "江玖鸢", gender: "female", power: 320, holderAccountId: "player", talentSeed: "durable" });
      general.status = "deployed";
      general.location = { x: 2, y: 2 };
      before.generals[general.id] = general;
      const recalled = applyIntent(before, {
        type: "recall-general", generalId: general.id, idempotencyKey: "durable-recall"
      }, { actorAccountId: "player", now: 2_000_000 }).state;

      const preparing = makeInstance();
      preparing.world = recalled;
      preparing.prepareIntentTransaction({ beforeWorld: before, mapDeltaId: "durable-map-delta", intentType: "recall-general", eventId: "durable-event" });
      const cached = preparing.loadCache("work");
      expect(cached.pendingIntentTransaction.afterOverlay.generals[general.id]).toMatchObject({ status: "carried", location: null });

      const committed = makeInstance();
      committed.world = structuredClone(before);
      delete committed.world.generals[general.id];
      committed.world.cells["2,2"].generalIds = [];
      committed.pendingIntentTransaction = structuredClone(cached.pendingIntentTransaction);
      committed.appliedMapDeltaIds.add("durable-map-delta");
      expect(committed.resolvePendingIntentTransaction()).toBe(true);
      expect(committed.world.generals[general.id]).toMatchObject({ status: "carried", location: null });
      expect(committed.world.players.player.carriedGeneralIds).toContain(general.id);

      const rolledBack = makeInstance();
      rolledBack.world = structuredClone(before);
      rolledBack.pendingIntentTransaction = structuredClone(cached.pendingIntentTransaction);
      expect(rolledBack.resolvePendingIntentTransaction()).toBe(true);
      expect(rolledBack.world.generals[general.id]).toMatchObject({ status: "deployed", location: { x: 2, y: 2 } });
      expect(rolledBack.world.players.player.carriedGeneralIds).not.toContain(general.id);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes complete legacy general archives and protects unknown branch content", () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player", username: "player@example" }) });
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.world.players.player = { accountId: "player", deviceSigningPublicKey: identity.signingPublicKey };
    const root = { id: "legacy-root", account_id: "player", root_comment_id: "legacy-root", content: "§FYOW3§GENERAL§guard§守将§2,2§r1" };
    const replies = [
      ...encodeCommentRecord(signRecord({ schema: "fyow.general-definition/3", id: "definition", generalId: "guard", setting: "x".repeat(3000) }, identity.signingPrivateKey)),
      ...encodeCommentRecord(signRecord({ schema: "fyow.general-memory/3", id: "memory", generalId: "guard", memory: "y".repeat(3000) }, identity.signingPrivateKey))
    ].map((content: string, index: number) => ({ id: `reply-${index}`, account_id: "player", parent_id: root.id, content }));
    const archive = instance.legacyGeneralArchiveSources([root, ...replies], "guard");
    expect(archive.archives).toHaveLength(1);
    expect(archive.sources.at(-1)).toBe(root);
    expect(archive.sources.slice(0, -1).every((source: any) => source.parent_id === root.id)).toBe(true);
    expect(instance.legacyGeneralArchiveSources([root], "guard")).toMatchObject({ archives: [], protectedRoots: 1 });

    const protectedArchive = instance.legacyGeneralArchiveSources([
      root, ...replies, { id: "unknown", account_id: "player", parent_id: root.id, content: "普通回复" }
    ], "guard");
    expect(protectedArchive.archives).toHaveLength(0);
    expect(protectedArchive.protectedRoots).toBe(1);
  });

  it("persists precise legacy archive retirement before deletion and resumes a partial failure", async () => {
    let now = 2_000_000;
    const deleteMany = vi.fn().mockRejectedValueOnce(new Error("temporary delete failure")).mockResolvedValueOnce({
      deletedCommentIds: ["legacy-reply"], alreadyMissingCommentIds: [], preservedRootCommentIds: ["legacy-root"]
    });
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "player@example" }),
      commentOperations: { publish: vi.fn(), delete: vi.fn(), deleteMany },
      now: () => now
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.world.playerEpochs.player = 0;
    instance.legacyGeneralArchiveSources = vi.fn((sources: any[]) => ({ archives: [{}], protectedRoots: 0, sources }));
    instance.verifyPublishedRecall = vi.fn(async () => ({
      verified: true,
      archive: {
        protectedRoots: 0,
        sources: [
          { id: "legacy-reply", account_id: "player", parent_id: "legacy-root" },
          { id: "legacy-root", account_id: "player" }
        ]
      }
    }));
    expect(await instance.retireLegacyGeneralArchive("guard", { mapDeltaId: "recall-map" })).toMatchObject({ deferred: true });
    expect(instance.pendingCommentRetirements).toHaveLength(1);
    expect(instance.pendingCommentRetirements[0].sources.map((source: any) => source.id)).toEqual(["legacy-reply", "legacy-root"]);

    instance.verifyPublishedRecall = vi.fn(async () => ({ verified: true, archive: { protectedRoots: 0, sources: [] } }));
    now = Number(instance.cloudUploadQueue[0]?.nextAttemptAt || now) + 1;
    expect(await instance.retryPendingCommentRetirements()).toBe(1);
    expect(instance.pendingCommentRetirements).toHaveLength(0);
    expect(deleteMany).toHaveBeenCalledTimes(2);
    const retriedDeletion = deleteMany.mock.calls.at(1)?.[0];
    expect(retriedDeletion?.sources.map((source: any) => source.id)).toEqual(["legacy-reply", "legacy-root"]);
  });

  it("keeps a minimal retirement proof when a just-published recall is not visible yet", async () => {
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "player@example" }),
      commentOperations: { publish: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.world.playerEpochs.player = 0;
    instance.verifyPublishedRecall = vi.fn(async () => ({ verified: false, reason: "map-delta-not-found", archive: null }));
    expect(await instance.retireLegacyGeneralArchive("guard", { mapDeltaId: "recall-map" })).toMatchObject({ deferred: true });
    expect(instance.pendingCommentRetirements).toEqual([expect.objectContaining({
      workId: "work", seasonId: "season", accountId: "player", generalId: "guard", mapDeltaId: "recall-map", sources: []
    })]);
  });

  it("verifies an accepted recall proof after a later write advances the same cell", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player", username: "player@example" }) });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: 1_000_000 });
    instance.world.playerEpochs.player = 0;
    instance.world.players.player = { accountId: "player", carriedGeneralIds: ["guard"] };
    instance.world.cells["2,2"] = { ownerAccountId: "player", soldiers: 99, generalIds: [] };
    instance.world.generals.guard = {
      ...createFallbackGeneral({ id: "guard", name: "守将", holderAccountId: "player" }),
      status: "carried", location: null
    };
    const transition = {
      generalId: "guard", holderAccountId: "player", from: { x: 2, y: 2 },
      targetStatus: "carried", nextHolderAccountId: "player", reason: "recalled"
    };
    const record = signRecord({
      schema: "fyow.map-delta/1", mapDeltaId: "accepted-recall", gameId: "cc.aiero.fyow.grid-conquest",
      workId: "work", seasonId: "season", actorAccountId: "player", playerEpoch: 0,
      participant: { displayName: "玩家" },
      changes: {
        cells: { "2,2": { ownerAccountId: "player", soldiers: 10, generalIds: [] } },
        generals: { guard: null }, generalTransitions: { guard: transition }
      },
      deviceSigningPublicKey: identity.signingPublicKey,
      deviceEncryptionPublicKey: identity.encryptionPublicKey
    }, identity.signingPrivateKey);
    const chunks = encodeCommentRecord(record);
    const sources = chunks.map((content: string, index: number) => ({
      id: `recall-part-${index + 1}`, account_id: "player", created_at: 2_000_000 + index,
      ...(index ? { parent_id: "recall-part-1" } : {}), content
    }));
    const order = recordPlatformOrder({ sources });
    const proof = {
      version: 1, mapDeltaId: record.mapDeltaId, recordHash: sha256(Buffer.from(canonicalJson(record))),
      sourceIds: sources.map((source: any) => source.id).sort(), actorAccountId: "player",
      transition, order, playerEpoch: 0
    };
    instance.publicGeneralRecalls.guard = proof;
    instance.publicCellOrders["2,2"] = { timestamp: order.timestamp + 1000, commentId: "later-garrison" };
    instance.readAllCommentSources = vi.fn(async () => sources);
    instance.validMapDelta = vi.fn(() => false);

    const verified = await instance.verifyPublishedRecall({ mapDeltaId: record.mapDeltaId, recallProof: proof }, "guard");
    expect(verified).toMatchObject({ verified: true, reason: "verified", recallProof: proof });
    expect(instance.validMapDelta).not.toHaveBeenCalled();
  });

  it("aborts lifecycle deletion when the target branch gains an unknown reply", async () => {
    const instance = service({ getAccount: () => ({ accountId: "player", username: "player@example" }) });
    instance.work = { id: "work", authorAccountId: "author" };
    const root = { id: "legacy-root", account_id: "player", content: "§FYOW3§GENERAL§guard§守将§2,2§r1" };
    const expected = { id: "legacy-reply", account_id: "player", parent_id: root.id, content: "expected" };
    instance.readAllCommentSources = vi.fn(async () => [root, expected]);
    const late = { id: "late-reply", account_id: "player", parent_id: root.id, content: "late" };
    instance.readCommentBranches = vi.fn()
      .mockResolvedValueOnce([expected])
      .mockResolvedValueOnce([expected, late]);
    await expect(instance.resolveCommentDeletionSources([expected.id, root.id], [expected, root])).rejects.toMatchObject({
      code: "PLATFORM_DELETE_BRANCH_CHANGED"
    });
    expect(instance.readCommentBranches).toHaveBeenNthCalledWith(1, root.id, expect.any(Number), expect.objectContaining({ strict: true, fresh: true }));
    expect(instance.readCommentBranches).toHaveBeenNthCalledWith(2, root.id, expect.any(Number), expect.objectContaining({ strict: true, fresh: true }));
  });

  it("does not delete a root whose stable branch contains an unowned source", async () => {
    const requestConsole = vi.fn(async () => ({}));
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "player@example" }),
      requestConsole
    });
    instance.work = { id: "work", authorAccountId: "author" };
    const root = { id: "legacy-root", account_id: "player", content: "archive" };
    const expected = { id: "legacy-reply", account_id: "player", parent_id: root.id, content: "expected" };
    const foreign = { id: "foreign-reply", account_id: "other", parent_id: root.id, content: "keep" };
    instance.readAllCommentSources = vi.fn(async () => [root, expected, foreign]);
    instance.readCommentBranches = vi.fn(async () => [expected, foreign]);
    await expect(instance.commentOperations.deleteMany({
      workId: "work",
      sources: [root, expected],
      knownOwnedCommentIds: [root.id, expected.id],
      deleteRoots: true
    })).rejects.toMatchObject({ code: "PLATFORM_DELETE_BRANCH_CHANGED" });
    expect(requestConsole).not.toHaveBeenCalled();
  });

  it("retires a recalled general archive only after the local action is committed", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "player@example" }),
      getIdentity: async () => identity,
      now: () => 2_000_000
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: 1_000_000 });
    instance.world.players.player = { accountId: "player", displayName: "玩家", gold: 1000, position: { x: 2, y: 2 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    instance.world.privatePlayers.player = {};
    instance.world.playerEpochs.player = 0;
    instance.world.cells["2,2"] = { ownerAccountId: "player", soldiers: 10, generalIds: ["guard"] };
    const guard = createFallbackGeneral({ id: "guard", name: "守将", gender: "female", power: 150, holderAccountId: "player" });
    guard.status = "deployed";
    guard.location = { x: 2, y: 2 };
    instance.world.generals.guard = guard;
    instance.publishMapChanges = vi.fn(async (changes: any, _identity: any, options: any) => ({ mapDeltaId: options.mapDeltaId, changes }));
    instance.handleEffects = vi.fn(async () => ({ deferred: [] }));
    instance.retireLegacyGeneralArchive = vi.fn(async () => {
      expect(instance.world.generals.guard).toMatchObject({ status: "carried", location: null });
      expect(instance.pendingIntentTransaction).toBeNull();
      expect(instance.pendingCommentRetirements).toEqual([expect.objectContaining({ generalId: "guard", sources: [] })]);
      return { deleted: 3 };
    });
    await instance.applyLocalIntent({ type: "recall-general", generalId: "guard", idempotencyKey: "recall-guard" }, "player");
    expect(instance.retireLegacyGeneralArchive).toHaveBeenCalledWith("guard", expect.objectContaining({ changes: expect.any(Object) }));
  });

  it("keeps full deployed-general archives in the owner overlay", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-deployed-archive-"));
    const cacheFile = path.join(directory, "cache.json");
    try {
      const instance = service({ cacheFile, getAccount: () => ({ accountId: "player", username: "player@example" }) });
      instance.work = { id: "work", authorAccountId: "author" };
      instance.control = { seasonId: "season", authorityAccountId: "author" };
      instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
      instance.world.players.player = { accountId: "player", displayName: "玩家", position: { x: 2, y: 2 }, carriedGeneralIds: [] };
      instance.world.playerEpochs.player = 0;
      instance.world.cells["2,2"] = { ownerAccountId: "player", soldiers: 10, generalIds: ["guard"] };
      const guard = createFallbackGeneral({ id: "guard", name: "守将", gender: "female", holderAccountId: "player", power: 320 });
      guard.status = "deployed";
      guard.location = { x: 2, y: 2 };
      instance.world.generals.guard = guard;
      instance.saveCache();
      const cached = instance.loadCache("work");
      expect(cached.world.generals.guard).toMatchObject({ status: "deployed", location: { x: 2, y: 2 } });
      expect(cached.localOverlay.generals.guard).toMatchObject({ status: "deployed", location: { x: 2, y: 2 } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays a legacy claim followed by a modern deployment across control updates and repeated entry", async () => {
    const fixture = coverageHarness();
    const { author, base } = fixture;
    const position = { x: 25, y: 9 };
    const key = "25,9";
    const guard = { ...createFallbackGeneral({ id: "guard", name: "守将", gender: "female", holderAccountId: "player" }),
      status: "deployed", location: position };
    delete guard.marketRelistAvailableAt;
    delete guard.experienceUpdatedAt;
    fixture.append(signRecord({ ...author.control, id: "program-update", occupationCountingProtocol: 1 },
      fixture.identities.author.signingPrivateKey), "author", base + 30);
    const claim = fixture.map("player", 40, {
      cells: { [key]: { ownerAccountId: "player", soldiers: 0, generalIds: [] } }
    });
    const deployment = fixture.map("player", 50, {
      cells: { [key]: { ownerAccountId: "player", soldiers: 0, generalIds: ["guard"] } },
      cellBases: { [key]: { cell: { ...claim.record.changes.cells[key], occupationCount: 0 },
        nextOccupationCount: 0, order: recordPlatformOrder(claim) } },
      generals: { guard }, generalTransitions: {}
    });
    const signedDeployment = canonicalJson(deployment.record);
    fixture.map("player", 60, {
      cells: { [key]: { ownerAccountId: "player", soldiers: 0, generalIds: [] } },
      cellBases: { [key]: { cell: null, nextOccupationCount: 1, order: { timestamp: 0, commentId: "" } } },
      generalTransitions: {}
    });
    const reader = fixture.create("player");
    reader.world = structuredClone(author.world);
    reader.world.players.player = { accountId: "player", position, gold: 1000, fieldArmySoldiers: 0, carriedGeneralIds: ["guard"] };
    reader.world.generals.guard = { ...guard, status: "carried", location: null, interactionHistory: [{ role: "user", content: "保留的对话" }] };
    for (let attempt = 0; attempt < 3; attempt++) {
      await reader.sync(true);
      expect(reader.world.cells[key]).toMatchObject({ ownerAccountId: "player", generalIds: ["guard"], occupationCount: 0 });
      expect(reader.world.generals.guard).toMatchObject({ status: "deployed", holderAccountId: "player", location: position });
      expect(reader.world.generals.guard.interactionHistory).toContainEqual({ role: "user", content: "保留的对话" });
      expect(reader.world.players.player.carriedGeneralIds).not.toContain("guard");
      expect(reader.publicGeneralOrders.guard).toEqual(recordPlatformOrder(deployment));
      expect(canonicalJson(deployment.record)).toBe(signedDeployment);
      expect(() => applyIntent(reader.world, { type: "talk-general", generalId: "guard", topic: "你好" },
        { actorAccountId: "player", now: base + 10_000 })).not.toThrow();
      const recall = applyIntent(reader.world, { type: "recall-general", generalId: "guard" },
        { actorAccountId: "player", now: base + 10_000 });
      expect(recall.state.generals.guard.status).toBe("carried");
    }
    const reopened = fixture.create("player");
    reopened.world = structuredClone(reader.world);
    reopened.localGeneralArchiveOrders = structuredClone(reader.localGeneralArchiveOrders);
    await reopened.sync(true);
    expect(reopened.world.generals.guard).toMatchObject({ status: "deployed", location: position });
    expect(reopened.world.cells[key].generalIds).toContain("guard");
  });

  it("repairs a compacted legacy recall only with signed holder and matching cell evidence, retaining dialogue", async () => {
    const fixture = coverageHarness();
    const { author } = fixture;
    const position = { x: 16, y: 3 };
    author.world.players.player = { accountId: "player", position, gold: 1000, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    author.world.cells["16,3"] = { ownerAccountId: "player", soldiers: 0, generalIds: [] };
    author.world.generals.guard = {
      ...createFallbackGeneral({ id: "guard", name: "守将", gender: "female", holderAccountId: "player" }),
      status: "deployed", location: position, interactionHistory: [{ role: "assistant", content: "云端对话" }]
    };
    const recall = fixture.map("player", 40, {
      cells: { "16,3": { ownerAccountId: "player", soldiers: 0, generalIds: [] } }, generals: { guard: null }
    });
    const garrison = fixture.map("player", 50, {
      cells: { "16,3": { ownerAccountId: "player", soldiers: 0, generalIds: [] } }
    });
    const coverage = {
      version: 1, through: { timestamp: 0, commentId: "" },
      appliedMapDeltaIds: [recall.record.mapDeltaId, garrison.record.mapDeltaId],
      generalOrders: { guard: recordPlatformOrder(recall) },
      cellOrders: { "16,3": recordPlatformOrder(garrison) }
    };
    fixture.snapshot(author.world, 70, coverage);
    const reader = fixture.create("player");
    reader.world = structuredClone(author.world);
    reader.world.generals.guard.interactionHistory.push({ role: "user", content: "本地对话" });
    await reader.sync(true);
    expect(reader.world.generals.guard).toMatchObject({ status: "carried", location: null, holderAccountId: "player" });
    expect(reader.world.generals.guard.interactionHistory).toHaveLength(2);
    expect(reader.world.players.player.carriedGeneralIds).toContain("guard");
    expect(reader.publicGeneralRecalls.guard).toMatchObject({ order: recordPlatformOrder(recall) });
    await reader.sync(true);
    expect(reader.world.generals.guard.status).toBe("carried");

    // A compaction by a different player must keep the verified recall archive.
    const observer = fixture.create("author");
    await observer.sync(true);
    expect(observer.world.generals.guard).toBeUndefined();
    fixture.snapshot(observer.world, 100, { ...coverage, generalRecalls: observer.publicGeneralRecalls });
    const reopened = fixture.create("player");
    await reopened.sync(true);
    expect(reopened.world.generals.guard).toMatchObject({ status: "carried", location: null });
    expect(reopened.world.players.player.carriedGeneralIds).toContain("guard");
    expect(reopened.world.generals.guard.interactionHistory).toEqual([]);
    expect(reopened.world.generals.guard.memoryText.length).toBeLessThanOrEqual(150);
    expect(reader.world.generals.guard.interactionHistory).toContainEqual({ role: "user", content: "本地对话" });
  });

  it("does not infer recalls from foreign tombstones or cells that still contain the general", () => {
    const fixture = coverageHarness();
    const reader = fixture.create("player");
    reader.control = fixture.author.control;
    reader.world = structuredClone(fixture.author.world);
    reader.world.cells["16,3"] = { ownerAccountId: "player", soldiers: 0, generalIds: ["guard"] };
    reader.world.generals.guard = {
      ...createFallbackGeneral({ id: "guard", holderAccountId: "player" }), status: "deployed", location: { x: 16, y: 3 }
    };
    for (const actor of ["author", "player"]) {
      const item = fixture.map(actor, 80, { cells: { "16,3": { ownerAccountId: actor, soldiers: 0, generalIds: [] } }, generals: { guard: null } });
      reader.publicGeneralOrders.guard = recordPlatformOrder(item);
      reader.publicCellOrders["16,3"] = recordPlatformOrder(item);
      reader.recoverLegacyGeneralRecalls([item]);
      expect(reader.world.generals.guard.status).toBe("deployed");
      expect(reader.publicGeneralRecalls.guard).toBeUndefined();
    }
  });

  it("preserves a newer confirmed local recall when an older deployment snapshot is restored", () => {
    const fixture = coverageHarness();
    const reader = fixture.create("player");
    reader.world = structuredClone(fixture.author.world);
    reader.world.players.player = { accountId: "player", carriedGeneralIds: ["guard"] };
    reader.world.cells["2,2"] = { ownerAccountId: "player", soldiers: 0, generalIds: ["guard"] };
    reader.world.generals.guard = { ...createFallbackGeneral({ id: "guard", holderAccountId: "player" }),
      status: "deployed", location: { x: 2, y: 2 } };
    reader.publicGeneralOrders.guard = { timestamp: fixture.base + 10, commentId: "old" };
    reader.restoreGeneralArchives({ generals: { guard: { ...reader.world.generals.guard, status: "carried", location: null } },
      generalOrders: { guard: { timestamp: fixture.base + 20, commentId: "new" } } });
    expect(reader.world.generals.guard).toMatchObject({ status: "carried", location: null });
  });

  it("rejects invalid public writes before posting rather than reporting a local-only success", async () => {
    const fixture = coverageHarness();
    const post = vi.fn();
    fixture.author.postRecord = post;
    await expect(fixture.author.publishMapChanges({
      cells: { "2,2": { ownerAccountId: "player", soldiers: 0, generalIds: [] } },
      generals: {}, generalTransitions: {}, cellBases: {}
    }, fixture.identities.author, { beforeWorld: structuredClone(fixture.author.world) })).rejects.toThrow("FYOW_MAP_DELTA_INVALID");
    expect(post).not.toHaveBeenCalled();
  });

  it("requires modern deployment and removal records to agree with their cell membership", () => {
    const fixture = coverageHarness();
    const guard = { ...createFallbackGeneral({ id: "guard", holderAccountId: "player" }),
      status: "deployed", location: { x: 2, y: 2 } };
    const base = { ownerAccountId: "player", soldiers: 0, generalIds: ["guard"], occupationCount: 0 };
    fixture.author.world.cells["2,2"] = base;
    fixture.author.world.generals.guard = guard;
    const orphan = fixture.map("player", 30, {
      cells: { "2,2": { ...base, generalIds: [] } }, generals: {}, generalTransitions: {},
      cellBases: { "2,2": { cell: base, order: { timestamp: 0, commentId: "" }, nextOccupationCount: 0 } }
    });
    expect(fixture.author.applyMapDelta(orphan)).toBe(false);
    expect(fixture.author.world.cells["2,2"].generalIds).toContain("guard");
    const noPlacement = fixture.map("player", 40, {
      cells: {}, cellBases: {}, generals: { absent: { ...guard, id: "absent", location: { x: 3, y: 3 } } }
    });
    expect(fixture.author.applyMapDelta(noPlacement)).toBe(false);
    expect(fixture.author.world.generals.absent).toBeUndefined();
  });

  it("rejects an unproven public general removal and only recalls after location proof", () => {
    const identity = generateOnlineWorldIdentity();
    const diagnostics: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "player@example" }),
      onDiagnostic: (detail: any) => diagnostics.push(detail)
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.world.players.player = { accountId: "player", displayName: "玩家", position: { x: 2, y: 2 }, carriedGeneralIds: [] };
    instance.world.playerEpochs.player = 0;
    instance.world.cells["2,2"] = { ownerAccountId: "player", soldiers: 10, generalIds: ["guard"] };
    const guard = createFallbackGeneral({ id: "guard", name: "守将", gender: "female", holderAccountId: "player", power: 320 });
    guard.status = "deployed";
    guard.location = { x: 2, y: 2 };
    instance.world.generals.guard = guard;
    const record = (mapDeltaId: string, generalTransitions: any, createdAt: number) => {
      const signed = signRecord({
        schema: "fyow.map-delta/1", mapDeltaId, gameId: instance.world.gameId, workId: "work", seasonId: "season",
        actorAccountId: "player", participant: { displayName: "玩家" }, playerEpoch: 0,
        deviceSigningPublicKey: identity.signingPublicKey, deviceEncryptionPublicKey: identity.encryptionPublicKey,
        changes: {
          cells: { "2,2": { ownerAccountId: "player", soldiers: 10, generalIds: [] } },
          generals: { guard: null }, ...(generalTransitions ? { generalTransitions } : {})
        }
      }, identity.signingPrivateKey);
      return { record: signed, sources: [{ id: `${mapDeltaId}-comment`, account_id: "player", created_at: createdAt }] };
    };
    expect(instance.applyMapDelta(record("legacy-remove", null, 1000))).toBe(true);
    expect(instance.world.generals.guard).toMatchObject({ status: "deployed", location: { x: 2, y: 2 } });
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: "general-removal-rejected", generalId: "guard" }));
    expect(instance.applyMapDelta(record("unproved-new-remove", {}, 1500))).toBe(false);
    expect(instance.world.generals.guard).toMatchObject({ status: "deployed", location: { x: 2, y: 2 } });
    expect(instance.applyMapDelta(record("proved-recall", {
      guard: {
        generalId: "guard", holderAccountId: "player", from: { x: 2, y: 2 },
        targetStatus: "carried", nextHolderAccountId: "player", reason: "recalled"
      }
    }, 2000))).toBe(true);
    expect(instance.world.generals.guard).toMatchObject({ status: "carried", location: null });
    expect(instance.world.players.player.carriedGeneralIds).toContain("guard");
  });

  it("keeps a completed march locally while its public record waits for reconnect", async () => {
    const identity = generateOnlineWorldIdentity();
    let online = false;
    let now = 2_000_000;
    let postSequence = 0;
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      requestConsole: async (_endpoint: string, options: any = {}) => {
        if (!online) throw new Error("connection interrupted");
        return { id: `posted-${++postSequence}`, account_id: "player", created_at: 2_000_000 + postSequence, ...options.body };
      },
      now: () => now
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", seed: "offline-march", startedAt: 1_000_000 });
    instance.world.players.player = { accountId: "player", displayName: "玩家", gold: 1000, position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    instance.world.privatePlayers.player = {};
    instance.world.playerEpochs.player = 0;
    instance.world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    instance.world.jobs.march = {
      id: "march", type: "march", accountId: "player", from: { x: 1, y: 1 }, to: { x: 2, y: 1 },
      path: [{ x: 1, y: 1 }, { x: 2, y: 1 }], generalIds: [], activeGeneralIds: [], soldiers: 1_000_000,
      attack: true, startedAt: 1_000_000, finishAt: 1_500_000
    };
    const effects = await instance.settleLocalClock(2_000_000);
    expect(effects.some((effect: any) => effect.type === "battle-won")).toBe(true);
    expect(instance.world.players.player.position).toEqual({ x: 2, y: 1 });
    expect(instance.world.jobs.march).toBeUndefined();
    expect(instance.pendingIntentTransaction).toMatchObject({ phase: "prepared", intentType: "time-settle" });
    expect(instance.status).toBe("pending-sync");
    const transactionId = instance.pendingIntentTransaction.transactionId;
    expect(instance.resolvePendingIntentTransaction()).toBe(false);
    expect(instance.world.players.player.position).toEqual({ x: 2, y: 1 });
    expect(await instance.settleLocalClock(2_000_001)).toEqual([]);
    expect(instance.pendingIntentTransaction.transactionId).toBe(transactionId);
    instance.calibrateClock = vi.fn(async () => null);
    instance.readHistory = vi.fn(async () => ({ assembled: { records: [] } }));
    instance.readWorldChatHistory = vi.fn(async () => ({ assembled: { records: [] } }));
    instance.receiveDirectWakes = vi.fn(async () => []);
    await expect(instance.sync()).resolves.toMatchObject({ status: "pending-sync" });
    expect(instance.world.jobs.march).toBeUndefined();
    expect(instance.pendingIntentTransaction.transactionId).toBe(transactionId);
    online = true;
    now = Math.max(now + 2_000, Number(instance.cloudUploadQueue[0]?.nextAttemptAt || 0) + 1);
    instance.readAllCommentSources = vi.fn(async () => []);
    await instance.retryPendingIntentTransactionPublish();
    expect(instance.pendingIntentTransaction.phase).toBe("published");
    delete instance.world.cells["2,1"];
    expect(instance.resolvePendingIntentTransaction()).toBe(true);
    expect(instance.world.cells["2,1"].ownerAccountId).toBe("player");
    expect(instance.world.players.player.position).toEqual({ x: 2, y: 1 });
  });

  it("rolls back deterministic map validation failures instead of retaining a disconnected transaction", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      now: () => 2_000_000
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", seed: "deterministic-map-error", startedAt: 1_000_000 });
    instance.world.players.player = {
      accountId: "player", displayName: "玩家", gold: 1000,
      position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: []
    };
    instance.world.privatePlayers.player = {};
    instance.world.playerEpochs.player = 0;
    instance.world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    instance.world.jobs.march = {
      id: "march", type: "march", accountId: "player", from: { x: 1, y: 1 }, to: { x: 2, y: 1 },
      path: [{ x: 1, y: 1 }, { x: 2, y: 1 }], generalIds: [], activeGeneralIds: [], soldiers: 100,
      attack: true, startedAt: 1_000_000, finishAt: 1_500_000
    };
    instance.publishMapChanges = vi.fn(async () => {
      const error: any = new Error("行动同步校验未通过，请重新同步后重试（FYOW_MAP_DELTA_INVALID）");
      error.code = "FYOW_MAP_DELTA_INVALID";
      throw error;
    });

    await expect(instance.settleLocalClock(2_000_000)).rejects.toMatchObject({ code: "FYOW_MAP_DELTA_INVALID" });
    expect(instance.pendingIntentTransaction).toBeNull();
    expect(instance.world.jobs.march).toBeDefined();
    expect(instance.world.players.player.position).toEqual({ x: 1, y: 1 });
  });

  it("treats a materialized empty neutral cell as the sparse public null base", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      now: () => 2_000_000
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", seed: "neutral-public-base", startedAt: 1_000_000 });
    instance.world.players.player = { accountId: "player", displayName: "玩家", position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    instance.world.playerEpochs.player = 0;
    instance.world.cells["2,2"] = { ownerAccountId: null, soldiers: 0, generalIds: [], occupationCount: 0 };
    const changes = {
      cells: { "2,2": { ownerAccountId: "player", soldiers: 1, generalIds: [] } },
      cellBases: { "2,2": { cell: null, nextOccupationCount: 1, order: { timestamp: 0, commentId: "" } } },
      generals: {}, generalTransitions: {}, marketListings: {}, marketSales: {}, claimedTreasures: {}, battles: {}, conquests: {}
    };
    const record = signRecord({
      schema: "fyow.map-delta/1", mapDeltaId: "neutral-base-map", gameId: instance.world.gameId,
      workId: "work", seasonId: "season", actorAccountId: "player", participant: { displayName: "玩家" },
      playerEpoch: 0, changes, deviceSigningPublicKey: identity.signingPublicKey,
      deviceEncryptionPublicKey: identity.encryptionPublicKey
    }, identity.signingPrivateKey);
    expect(instance.validMapDelta({ record, sources: [{ id: "neutral-base", account_id: "player", created_at: 2 }] })).toBe(true);
  });

  it("opens the verified map with a pending write, keeps polling, and recovers without replaying the action", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-pending-entry-"));
    const fixture = coverageHarness("pending-work");
    const seed = fixture.create("player");
    const reader = fixture.create("player");
    let testNow = fixture.base + 10_000;
    seed.rawNow = reader.rawNow = () => testNow;
    let online = false;
    let posts = 0;
    try {
      fixture.author.world.players.player = {
        accountId: "player", displayName: "玩家", gold: 700, basePower: 100, power: 100,
        position: { x: 2, y: 2 }, carriedGeneralIds: [], fieldArmySoldiers: 40
      };
      fixture.author.world.privatePlayers.player = { orientation: "any", note: "preserve dialogue" };
      fixture.snapshot(fixture.author.world, 30);
      seed.cacheFile = reader.cacheFile = path.join(directory, "cache.json");
      seed.world = structuredClone(fixture.author.world);
      seed.control = structuredClone(fixture.author.control);
      seed.pendingCommentRetirements = [{
        version: 1, workId: "pending-work", seasonId: "season", accountId: "player",
        playerEpoch: 0, generalId: "legacy-guard", mapDeltaId: "verified-recall", sources: [], createdAt: fixture.base
      }];
      const before = structuredClone(seed.world);
      seed.world.players.player.position = { x: 3, y: 3 };
      seed.world.cells["3,3"] = { ownerAccountId: "player", soldiers: 4, generalIds: [] };
      seed.prepareIntentTransaction({
        beforeWorld: before, mapDeltaId: "pending-entry-map", intentType: "time-settle", eventId: "settled-once",
        changes: { cells: { "3,3": seed.world.cells["3,3"] }, generals: {} }
      });
      const request = reader.requestConsole;
      reader.requestConsole = async (endpoint: string, options: any = {}) => {
        if (endpoint.startsWith("/installed-apps/")) return { id: "pending-work", created_by_account_id: "author" };
        if (options.method !== "POST") return request(endpoint, options);
        posts += 1;
        if (!online) throw Object.assign(new Error("platform rate limit"), { code: "PLATFORM_RATE_LIMITED", status: 429 });
        const source = { id: `pending-post-${posts}`, account_id: "player", created_at: fixture.base + 100 + posts, ...options.body };
        if (options.body.parent_id) fixture.roots.find(root => root.id === options.body.parent_id).children.push(source);
        else fixture.roots.push({ ...source, children: [] });
        return source;
      };
      const state = await reader.open({ workUrl: "https://aigirlfriend.baby/zh/explore/installed/pending-work" });
      expect(state).toMatchObject({ status: "pending-sync", initialized: true, loadProgress: { phase: "complete", active: false } });
      expect(state.error).toContain("自动重试");
      expect(reader.pollTimer).not.toBeNull();
      expect(reader.pendingCommentRetirements).toEqual(seed.pendingCommentRetirements);
      expect(reader.pendingIntentTransaction.lastPublishError).toMatchObject({ code: "PLATFORM_RATE_LIMITED", status: 429 });
      const transactionId = reader.pendingIntentTransaction.transactionId;
      const beforePoll = posts;
      await vi.advanceTimersByTimeAsync(5000);
      expect(posts).toBe(beforePoll);
      expect(reader.pendingIntentTransaction.transactionId).toBe(transactionId);
      expect(reader.pollFailureCount).toBe(0);
      online = true;
      testNow += 30_100;
      await vi.advanceTimersByTimeAsync(30_100);
      const recovered = reader.state();
      expect(recovered.status).toBe("ready");
      expect(reader.pendingIntentTransaction).toBeNull();
      expect(reader.world.cells["3,3"].soldiers).toBe(4);
      expect(reader.world.players.player).toMatchObject({ gold: 700, fieldArmySoldiers: 40, position: { x: 3, y: 3 } });
      expect(reader.world.privatePlayers.player.note).toBe("preserve dialogue");
      const committedPosts = posts;
      await reader.sync();
      expect(posts).toBe(committedPosts);
    } finally {
      seed.close();
      reader.close();
      vi.useRealTimers();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 1, 3])("recovers an ambiguous chunk %i response from the cloud without posting it twice", async lostPart => {
    const fixture = coverageHarness();
    const writer = fixture.create("player");
    writer.world = structuredClone(fixture.author.world);
    writer.control = structuredClone(fixture.author.control);
    writer.world.players.player = { accountId: "player", displayName: "original", position: { x: 1, y: 1 }, carriedGeneralIds: [] };
    const changes = { cells: { "2,2": { ownerAccountId: "player", soldiers: 5, generalIds: [] } }, generals: {}, padding: crypto.randomBytes(3000).toString("hex") };
    writer.prepareIntentTransaction({ beforeWorld: structuredClone(writer.world), mapDeltaId: "resume-same-map", intentType: "time-settle", changes });
    const roots: any[] = [];
    const submitted: string[] = [];
    let interrupted = false;
    const transport = async (_endpoint: string, options: any) => {
      submitted.push(options.body.content);
      const source = { id: `chunk-${submitted.length}`, account_id: "player", created_at: fixture.base + 200 + submitted.length, ...options.body };
      if (options.body.parent_id) roots.find(root => root.id === options.body.parent_id).children.push(source);
      else roots.push({ ...source, children: [] });
      if (!interrupted && submitted.length - 1 === lostPart) {
        interrupted = true;
        throw Object.assign(new Error("response lost after server accepted chunk"), { code: "PLATFORM_TIMEOUT" });
      }
      return source;
    };
    writer.requestConsole = transport;
    await expect(writer.retryPendingIntentTransactionPublish()).rejects.toThrow("response lost");
    const saved = structuredClone(writer.pendingIntentTransaction);
    expect(saved.publication.sources.filter(Boolean)).toHaveLength(lostPart);
    const restarted = fixture.create("player");
    restarted.control = structuredClone(fixture.author.control);
    restarted.world = structuredClone(writer.world);
    restarted.world.players.player.displayName = "renamed after disconnect";
    restarted.pendingIntentTransaction = saved;
    restarted.requestConsole = transport;
    restarted.reconcilePendingPublication(extractCommentItems({ data: roots }));
    expect(restarted.pendingIntentTransaction.publication.sources.filter(Boolean)).toHaveLength(lostPart + 1);
    restarted.now = () => fixture.base + 12_000;
    restarted.readAllCommentSources = vi.fn(async () => extractCommentItems({ data: roots }));
    await restarted.retryPendingIntentTransactionPublish();
    const chunks = encodeCommentRecord(saved.publication.record);
    expect(chunks.length).toBeGreaterThan(3);
    expect(submitted).toEqual(chunks);
    expect(roots).toHaveLength(1);
    const assembled = assembleCommentRecords(extractCommentItems({ data: roots }));
    expect(assembled.incomplete).toHaveLength(0);
    expect(assembled.records[0].record.participant.displayName).toBe("original");
    expect(restarted.resolvePendingIntentTransaction()).toBe(true);
    expect(restarted.world.cells["2,2"].soldiers).toBe(5);
  });

  it("waits for a second independent cloud read before retrying an ambiguous root write", async () => {
    const identity = generateOnlineWorldIdentity();
    let now = 2_000_000;
    let loseFirstResponse = true;
    let sequence = 0;
    const roots: any[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      getIdentity: async () => identity,
      now: () => now,
      requestConsole: async (_endpoint: string, options: any = {}) => {
        const source = { id: `cloud-${++sequence}`, account_id: "player", created_at: now, ...options.body };
        if (options.body.parent_id) roots.find(root => root.id === options.body.parent_id).children.push(source);
        else roots.push({ ...source, children: [] });
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw Object.assign(new Error("response lost after platform accepted root"), { code: "PLATFORM_TIMEOUT" });
        }
        return source;
      }
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season", startedAt: 1_000_000 });
    instance.world.players.player = {
      accountId: "player", displayName: "玩家", gold: 1000, fieldArmySoldiers: 0,
      carriedGeneralIds: ["g1"], position: { x: 1, y: 1 }
    };
    instance.world.privatePlayers.player = {};
    instance.world.cells["1,1"] = { ownerAccountId: "player", soldiers: 10, generalIds: [] };
    instance.world.generals.g1 = createFallbackGeneral({ id: "g1", name: "试将", holderAccountId: "player", power: 300 });

    expect((await instance.submitIntent({ type: "deploy-general", generalId: "g1", idempotencyKey: "ambiguous-deploy" })).pendingSync).toBe(true);
    expect(roots).toHaveLength(1);
    await expect(instance.retryPendingIntentTransactionPublish()).rejects.toMatchObject({ code: "FYOW_PUBLICATION_RECHECK_PENDING" });
    expect(roots).toHaveLength(1);
    expect(instance.world.generals.g1.status).toBe("deployed");

    now = Math.max(now + 2_000, Number(instance.cloudUploadQueue[0]?.nextAttemptAt || 0) + 1);
    const fullRead = vi.fn(async () => extractCommentItems({ data: roots }));
    instance.readAllCommentSources = fullRead;
    await instance.retryPendingIntentTransactionPublish();
    expect(fullRead).toHaveBeenCalledWith(expect.objectContaining({
      includeAllBranches: true, strictBranches: true, requireStable: true, fresh: true
    }));
    expect(roots).toHaveLength(1);
    expect(instance.pendingIntentTransaction).toMatchObject({ phase: "published" });
  });

  it.each(["journal", "legacy"])("resumes %s successful chunks after an explicit failure without creating a second root", async mode => {
    const fixture = coverageHarness();
    const writer = fixture.create("player");
    writer.control = structuredClone(fixture.author.control);
    writer.world = structuredClone(fixture.author.world);
    const changes = { cells: { "2,2": { ownerAccountId: "player", soldiers: 5, generalIds: [] } }, generals: {}, padding: crypto.randomBytes(1800).toString("hex") };
    writer.prepareIntentTransaction({ beforeWorld: structuredClone(writer.world), mapDeltaId: "resume-confirmed", intentType: "time-settle", changes });
    const posted: any[] = [];
    let fail = true;
    writer.requestConsole = async (_endpoint: string, options: any) => {
      if (fail && posted.length === 1) throw Object.assign(new Error("rate limit"), { code: "PLATFORM_RATE_LIMITED" });
      const source = { id: `saved-${posted.length}`, account_id: "player", created_at: fixture.base + 200, ...options.body };
      posted.push(source);
      return source;
    };
    await expect(writer.retryPendingIntentTransactionPublish()).rejects.toThrow("rate limit");
    expect(writer.pendingIntentTransaction.publication.sources).toHaveLength(1);
    if (mode === "legacy") delete writer.pendingIntentTransaction.publication;
    fail = false;
    const retryAt = Number(writer.cloudUploadQueue[0]?.nextAttemptAt || 0);
    writer.now = () => retryAt + 1;
    await writer.retryPendingIntentTransactionPublish(mode === "legacy" ? { comments: extractCommentItems({ data: posted }) } : {});
    expect(posted.filter(item => !item.parent_id)).toHaveLength(1);
    expect(posted.slice(1).every(item => item.parent_id === "saved-0")).toBe(true);
    expect(new Set(posted.map(item => item.content)).size).toBe(posted.length);
    expect(writer.pendingIntentTransaction.phase).toBe("published");
  });

  it("does not publish an altered saved transaction signature", async () => {
    const fixture = coverageHarness();
    const writer = fixture.create("player");
    writer.control = structuredClone(fixture.author.control);
    writer.world = structuredClone(fixture.author.world);
    const changes = { cells: { "2,2": { ownerAccountId: "player", soldiers: 5, generalIds: [] } }, generals: {} };
    writer.prepareIntentTransaction({ beforeWorld: structuredClone(writer.world), mapDeltaId: "signed-outbox", intentType: "time-settle", changes });
    writer.requestConsole = vi.fn(async () => { throw Object.assign(new Error("429"), { code: "PLATFORM_RATE_LIMITED" }); });
    await expect(writer.retryPendingIntentTransactionPublish()).rejects.toThrow("429");
    writer.pendingIntentTransaction.publication.record.participant.displayName = "tampered";
    await expect(writer.retryPendingIntentTransactionPublish()).rejects.toMatchObject({ code: "FYOW_OUTBOX_INVALID" });
    expect(writer.requestConsole).toHaveBeenCalledTimes(1);
    expect(writer.pendingIntentTransaction.phase).toBe("prepared");
  });

  it("finishes local travel when comment reads fail, without fighting on a stale map", async () => {
    const instance = service({
      getAccount: () => ({ accountId: "player" }),
      getIdentity: async () => generateOnlineWorldIdentity(),
      requestConsole: vi.fn(async () => { throw new Error("503"); }),
      now: () => 2_000_000
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ seed: "local-travel", seasonId: "season", startedAt: 1_000_000 });
    instance.world.players.player = { accountId: "player", gold: 500, position: { x: 1, y: 1 }, fieldArmySoldiers: 0, carriedGeneralIds: [] };
    instance.world.privatePlayers.player = {};
    instance.world.jobs.travel = {
      id: "travel", type: "march", accountId: "player", from: { x: 1, y: 1 }, to: { x: 2, y: 1 },
      path: [{ x: 2, y: 1 }], generalIds: [], activeGeneralIds: [], soldiers: 53, attack: false,
      startedAt: 1_000_000, finishAt: 1_500_000
    };
    instance.calibrateClock = vi.fn(async () => null);
    instance.readHistory = vi.fn(async () => { throw new Error("connection interrupted"); });
    await expect(instance.sync()).rejects.toThrow("connection interrupted");
    expect(instance.world.jobs.travel).toBeUndefined();
    expect(instance.world.players.player).toMatchObject({ position: { x: 2, y: 1 }, fieldArmySoldiers: 53, gold: 500 });
    expect(instance.pendingIntentTransaction).toBeNull();
    const world = structuredClone(instance.world);
    world.jobs.attack = {
      id: "attack", type: "march", accountId: "player", from: { x: 2, y: 1 }, to: { x: 3, y: 1 },
      path: [{ x: 3, y: 1 }], generalIds: [], activeGeneralIds: [], soldiers: 53, attack: true,
      startedAt: 1_000_000, finishAt: 1_500_000
    };
    instance.world = world;
    await expect(instance.sync()).rejects.toThrow("connection interrupted");
    expect(instance.world.jobs.attack).toBeDefined();
    expect(instance.world.players.player.position).toEqual({ x: 2, y: 1 });
  });

  it("keeps the map connected when only world chat or snapshot compaction fails", async () => {
    const fixture = coverageHarness();
    const instance = fixture.create();
    await instance.sync();
    instance.readWorldChatHistory = vi.fn(async () => { throw new Error("chat 503"); });
    instance.publicDeltaCountSinceSnapshot = 32;
    instance.publishSnapshot = vi.fn(async () => { throw new Error("snapshot 503"); });
    const state = await instance.sync();
    expect(state.status).toBe("ready");
    expect(state.error).toBeNull();
    expect(instance.readWorldChatHistory).toHaveBeenCalledOnce();
    expect(instance.publishSnapshot).toHaveBeenCalledOnce();
  });

  it("retries transient comment reads once, but not authentication errors", async () => {
    const requestConsole = vi.fn()
      .mockRejectedValueOnce(new Error("platform 503"))
      .mockResolvedValueOnce({ data: [] });
    const instance = service({ requestConsole });
    instance.work = { id: "work" };
    expect(await instance.readHistoryPage(1)).toEqual([]);
    expect(requestConsole).toHaveBeenCalledTimes(2);
    requestConsole.mockClear().mockRejectedValue(new Error("401 Unauthorized"));
    await expect(instance.readHistoryPage(1)).rejects.toThrow("401");
    expect(requestConsole).toHaveBeenCalledTimes(1);
  });

  it("retries a temporary branch outage before accepting the complete signed record", async () => {
    const fixture = coverageHarness();
    const instance = fixture.create();
    await instance.sync();
    const request = instance.requestConsole;
    let failed = false;
    instance.requestConsole = vi.fn(async (endpoint: string, options: unknown) => {
      if (endpoint.includes("/branches/") && !failed) { failed = true; throw new Error("Failed to fetch"); }
      return request(endpoint, options);
    });
    await instance.readCommentBranches("fixture-root", 1);
    expect(failed).toBe(true);
    const branches = instance.requestConsole.mock.calls.filter(([endpoint]: string[]) => endpoint?.includes("/branches/"));
    expect(branches).toHaveLength(2);
    expect(instance.world).toBeTruthy();
  });

  it("rejects malformed cloud lists and retains the current world on a failed sync", async () => {
    const fixture = coverageHarness();
    const instance = fixture.create();
    await instance.sync();
    const world = JSON.parse(JSON.stringify(instance.world));
    instance.requestConsole = async () => ({ code: 100000, data: {} });
    await expect(instance.sync()).rejects.toThrow("PLATFORM_DATA_SHAPE");
    expect(instance.world).toEqual(world);
    expect(instance.status).toBe("degraded");
  });

  it("does not retry rejected writes or writes during platform rate limiting", async () => {
    for (const status of [401, 403, 429]) {
      const write = vi.fn(async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); });
      const instance = service({});
      await expect(instance.retryPlatformWrite(write)).rejects.toThrow(String(status));
      expect(write).toHaveBeenCalledOnce();
    }
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
    instance.readAllCommentSources = vi.fn(async () => []);
    instance.syncNow = vi.fn(async () => instance.state());
    const result = await instance.exportMigrationDraft();
    expect(result.redirectPublished).not.toBe(true);
    expect(result.requiresConfigurationImport).toBe(true);
    expect(result.importError).toContain("fixture import rejected");
    expect(postedComments).toHaveLength(0);
  });

  it("starts migration from the signed card snapshot without exporting the old work first", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author" });
    const endpoints: string[] = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        endpoints.push(endpoint);
        if (endpoint === "/apps" && options.method === "POST") return { data: { app: { id: "new-work-123" } } };
        if (endpoint === "/apps/new-work-123/model-config" && options.method === "POST") throw new Error("fixture import stopped");
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      }
    });
    instance.card = rebindGameCard(createBundledGridCard(), "old-work-123");
    instance.work = { id: "old-work-123", name: "猎艳疆土", description: "program", authorAccountId: "author" };
    instance.control = { seasonId: world.seasonId, authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey };
    instance.world = world;
    instance.readAllCommentSources = vi.fn(async () => []);
    instance.syncNow = vi.fn(async () => instance.state());

    const result = await instance.exportMigrationDraft();
    expect(result).toMatchObject({ workId: "new-work-123", requiresConfigurationImport: true });
    expect(endpoints).not.toContain("/apps/old-work-123/model-config/export");
    expect(endpoints[0]).toBe("/apps");
  });

  it("initializes the copied ledger before publishing a verified reset redirect", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    world.players.legacy = { accountId: "legacy", displayName: "旧玩家", gold: 999, fieldArmySoldiers: 88 };
    world.playerEpochs.legacy = 0;
    world.cells["1,1"] = { ownerAccountId: "legacy", soldiers: 50, generalIds: [] };
    const worldBook = [{
      group: "系统任务",
      match_type: 2,
      key: "_or_[[TASK:test:v1]]",
      key_region: 2,
      value_type: 0,
      value: "返回结构化结果",
      probability: 100,
      enable: true
    }];
    const exportData = { name: "艳猎征途", desc: "program", prpt: "world", pretxt: "prefix", posttxt: "post", world_book: worldBook };
    const comments: Array<{ endpoint: string; content: string }> = [];
    let oldSavedName = "";
    let createBody: any = null;
    let targetConfigBody: any = null;
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps/old/model-config/export") return oldSavedName ? { data: { ...exportData, name: oldSavedName } } : { data: exportData };
        if (endpoint === "/apps" && options.method === "POST") { createBody = options.body; return { data: { app: { id: "new" } } }; }
        if (endpoint === "/apps/new/model-config" && options.method === "POST") { targetConfigBody = options.body; return { ok: true }; }
        if (endpoint === "/apps/new/model-config/export") return { data: exportData };
        if (endpoint === "/apps/old/model-config" && options.method === "POST") { oldSavedName = options.body.app.name; return { ok: true }; }
        if (endpoint.startsWith("/comments/") && options.method === "POST") { comments.push({ endpoint, content: options.body.content }); return { id: `c${comments.length}` }; }
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      }
    });
    instance.work = { id: "old", name: "艳猎征途", description: "program", authorAccountId: "author" };
    instance.control = { schema: "fyow.control/3", id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId: "old", seasonId: world.seasonId, programHash: instance.currentProgramHash(), authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey, startedAt: world.startedAt, updatedAt: world.startedAt };
    instance.world = world;
    instance.readAllCommentSources = vi.fn(async () => []);
    instance.syncNow = vi.fn(async () => instance.state());
    instance.verifyMigrationTargetLedger = vi.fn(async (draft: any) => { draft.targetLedgerVerified = true; return { verified: true }; });
    const result = await instance.exportMigrationDraft();
    expect(result.importError).toBeUndefined();
    expect(result.redirectPublished).toBe(true);
    expect(createBody).toMatchObject({ mode: "chat", type: 1 });
    expect(targetConfigBody).toMatchObject({
      pre_prompt: "world",
      pre_text: "prefix",
      post_text: "post",
      world_book: worldBook,
      app: { name: "猎艳疆土[new]", gender: 1, mod_permission: 4, is_available_not_public: true }
    });
    expect(targetConfigBody).not.toHaveProperty("prpt");
    expect(instance.work.id).toBe("new");
    const assembledNewRecords = assembleCommentRecords(comments.filter(item => item.endpoint === "/comments/new/1").map((item, index) => ({ id: `n${index}`, content: item.content }))).records;
    const newRecords = assembledNewRecords.map((item: any) => item.record.schema);
    const oldRecords = assembleCommentRecords(comments.filter(item => item.endpoint === "/comments/old/1").map((item, index) => ({ id: `o${index}`, content: item.content }))).records.map((item: any) => item.record.schema);
    expect(newRecords).toContain("fyow.control/3");
    expect(newRecords).toContain("fyow.snapshot/3");
    expect(oldRecords).toContain("fyow.reset/3");
    const targetSnapshot = assembledNewRecords.find((item: any) => item.record.schema === "fyow.snapshot/3")?.record;
    expect(targetSnapshot.state.players).toEqual({});
    expect(targetSnapshot.state.cells["1,1"]).toBeUndefined();
  }, 15_000);

  it("publishes the redirect without modifying the obsolete work configuration", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    const exportData = { name: "只读旧服", desc: "program", type: 2, prpt: "world", pretxt: "prefix", posttxt: "post", world_book: [] };
    const comments: Array<{ endpoint: string; content: string }> = [];
    const instance = service({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps/old/model-config/export") return { data: exportData };
        if (endpoint === "/apps" && options.method === "POST") return { data: { app: { id: "editable-new" } } };
        if (endpoint === "/apps/editable-new/model-config" && options.method === "POST") return { ok: true };
        if (endpoint === "/apps/editable-new/model-config/export") return { data: exportData };
        if (endpoint === "/apps/old/model-config" && options.method === "POST") throw new Error("当前作品类型不允许操作");
        if (endpoint.startsWith("/comments/") && options.method === "POST") { comments.push({ endpoint, content: options.body.content }); return { id: `c${comments.length}` }; }
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      }
    });
    instance.work = { id: "old", name: "只读旧服", description: "program", authorAccountId: "author" };
    instance.control = { schema: "fyow.control/3", id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId: "old", seasonId: "season", programHash: instance.currentProgramHash(), authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey, authorityEncryptionPublicKey: identity.encryptionPublicKey, startedAt: world.startedAt, updatedAt: world.startedAt };
    instance.world = world;
    instance.readAllCommentSources = vi.fn(async () => []);
    instance.syncNow = vi.fn(async () => instance.state());
    instance.verifyMigrationTargetLedger = vi.fn(async (draft: any) => { draft.targetLedgerVerified = true; return { verified: true }; });

    const result = await instance.exportMigrationDraft();
    expect(result).toMatchObject({ redirectPublished: true, configurationImported: true, oldWorkRenamed: false });
    const oldRecords = assembleCommentRecords(comments.filter(item => item.endpoint === "/comments/old/1").map((item, index) => ({ id: `o${index}`, content: item.content }))).records;
    expect(oldRecords.some((item: any) => item.record.schema === "fyow.reset/3" && item.record.newWorkId === "editable-new")).toBe(true);
  }, 15_000);

  it("isolates cached game records by account inside the same app instance", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-account-cache-"));
    const cacheFile = path.join(directory, "cache.json");
    try {
      const first = service({ cacheFile, getAccount: () => ({ accountId: "player-a" }) });
      first.work = { id: "work", authorAccountId: "author" };
      first.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
      first.world.players["player-a"] = { accountId: "player-a", displayName: "甲", gold: 111 };
      first.saveCache();

      const second = service({ cacheFile, getAccount: () => ({ accountId: "player-b" }) });
      expect(second.loadCache("work")).toBeNull();
      second.work = { id: "work", authorAccountId: "author" };
      second.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
      second.world.players["player-b"] = { accountId: "player-b", displayName: "乙", gold: 222 };
      second.saveCache();

      expect(first.loadCache("work")?.cacheAccountId).toBe("player-a");
      expect(second.loadCache("work")?.cacheAccountId).toBe("player-b");
      const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      expect(Object.keys(persisted.accounts).sort()).toEqual(["player-a", "player-b"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds cached letters to one game season without dropping them on a program-control update", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-letter-session-"));
    const cacheFile = path.join(directory, "cache.json");
    try {
      const startedAt = 1_000_000;
      const currentControl = { id: "control-current", seasonId: "season-reused", startedAt, authorityAccountId: "author" };
      const first = service({ cacheFile, getAccount: () => ({ accountId: "player" }) });
      first.work = { id: "work", authorAccountId: "author" };
      first.control = currentControl;
      first.world = createWorld({ seasonId: "season-reused", startedAt, authorityAccountId: "author" });
      first.directInbox = [
        { messageId: "old", createdAt: 1_000 },
        { messageId: "current-tagged", gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season-reused", controlId: "control-current", createdAt: 1_001_000 }
      ];
      first.directHistory = [
        ...first.directInbox,
        { messageId: "current-legacy", createdAt: 1_002_000 },
        { messageId: "updated-control", workId: "work", seasonId: "season-reused", controlId: "control-new", createdAt: 1_003_000 },
        { messageId: "foreign-season", workId: "work", seasonId: "season-old", controlId: "control-old", createdAt: 1_004_000 }
      ];
      first.seenDirectMessageIds = new Set(["old", "current-tagged", "current-legacy", "updated-control", "foreign-season"]);
      first.saveCache();

      const cached = first.loadCache("work");
      expect(cached.directSession).toMatchObject({ workId: "work", seasonId: "season-reused", controlId: "control-current", startedAt });
      expect(cached.directInbox.map((item: any) => item.messageId)).toEqual(["current-tagged"]);
      expect(cached.directHistory.map((item: any) => item.messageId)).toEqual(["current-tagged", "current-legacy", "updated-control"]);
      const second = service({ cacheFile, getAccount: () => ({ accountId: "player" }) });
      second.work = first.work;
      second.control = currentControl;
      second.world = createWorld({ seasonId: "season-reused", startedAt, authorityAccountId: "author" });
      second.restoreDirectCache(cached);
      expect(second.directHistory.map((item: any) => item.messageId)).toEqual(["current-tagged", "current-legacy", "updated-control"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("freezes the old ledger as soon as a signed migration redirect is detected", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = service({ getAccount: () => ({ accountId: "player", username: "玩家" }) });
    instance.work = { id: "old-work", authorAccountId: "author" };
    instance.control = {
      id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId: "old-work", seasonId: "season",
      authorityAccountId: "author", authoritySigningPublicKey: identity.signingPublicKey
    };
    instance.world = createWorld({ seasonId: "season", authorityAccountId: "author" });
    instance.world.players.player = { accountId: "player", displayName: "玩家", position: { x: 1, y: 1 }, fieldArmySoldiers: 10, carriedGeneralIds: [] };
    const reset = signRecord({
      schema: "fyow.reset/3", resetId: "reset", gameId: "cc.aiero.fyow.grid-conquest", seasonId: "season",
      oldWorkId: "old-work", newWorkId: "new-work", newWorkUrl: "https://aigirlfriend.baby/zh/explore/installed/new-work",
      exportSha256: "fixture", issuedAt: 2000
    }, identity.signingPrivateKey);
    instance.readHistory = vi.fn(async () => ({
      assembled: { records: [{ record: reset, sources: [{ id: "reset-comment", account_id: "author", created_at: 2000 }] }] }
    }));
    instance.settleLocalClock = vi.fn(async () => null);

    const state = await instance.syncNow(true);
    expect(state.status).toBe("migrating");
    expect(state.migration).toMatchObject({ workId: "new-work" });
    expect(instance.settleLocalClock).not.toHaveBeenCalled();
    await expect(instance.submitIntent({ type: "quote-march", to: { x: 2, y: 2 }, soldiers: 1 })).rejects.toThrow(/正在搬迁/);
  });
});
