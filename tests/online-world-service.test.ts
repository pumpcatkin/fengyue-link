import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { OnlineWorldService, workReference, normalizeWorkDetail, bindWorldAuthority, recordPlatformOrder, playerContextFromProfile, playerContextQualityIssue, generalGenerationQualityIssue, normalizeGeneratedGeneral, dialogueQualityIssue, compactDialogueReply, generalMemoryQualityIssue } = require("../electron/online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("../electron/online-world-crypto.cjs");
const { assembleCommentRecords, encodeCommentRecord, signRecord, canonicalJson, sha256 } = require("../electron/online-world-protocol.cjs");
const { createWorld, createFallbackGeneral, battleCasualties, generatedGeneralPower, staticCell } = require("../electron/grid-world-game.cjs");
const { packProgram } = require("../electron/online-world-runtime.cjs");
const { createBundledGridCard, rebindGameCard } = require("../electron/online-world-card.cjs");

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

function coverageHarness() {
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
    instance.work = { id: "work", authorAccountId: "author" };
    instance.status = "ready";
    return instance;
  };
  const author = create();
  author.control = signRecord({
    schema: "fyow.control/3", id: "control", gameId: "cc.aiero.fyow.grid-conquest", workId: "work", seasonId: "season",
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
      schema: "fyow.snapshot/3", snapshotId: `snapshot-${time}`, gameId: author.world.gameId, workId: "work", seasonId: "season",
      revision: state.revision || 0, state: publicState, stateHash: sha256(Buffer.from(canonicalJson(publicState))),
      ...(coverage ? { ledgerCoverage: coverage } : {})
    }, identities.author.signingPrivateKey), "author", base + time);
  };
  snapshot(author.world, 10, { version: 1, through: { timestamp: 0, commentId: "" } });
  const map = (actor: string, time: number, changes: any, extra: any = {}) => append(signRecord({
    schema: "fyow.map-delta/1", mapDeltaId: `map-${actor}-${time}`, gameId: author.world.gameId, workId: "work", seasonId: "season",
    actorAccountId: actor, participant: { displayName: actor }, playerEpoch: 0,
    deviceSigningPublicKey: identities[actor].signingPublicKey,
    changes: { cells: {}, generals: {}, ...changes }, ...extra
  }, identities[actor].signingPrivateKey), actor, base + time);
  return { author, create, append, snapshot, map, roots, base, identities };
}

describe("online world platform service", () => {
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
    expect(normalizeGeneratedGeneral({ ...completeGeneral, coreSetting: "善战。", power: 999999 }, { gender: "female" })).toMatchObject({ coreSetting: "善战。", power: 300 });
    const seededPower = normalizeGeneratedGeneral(completeGeneral, {
      gender: "female", generatedSeed: "season-seed", accountId: "player", sourceId: "discovery"
    }).power;
    expect(seededPower).toBe(generatedGeneralPower("season-seed", "player", "discovery"));
    expect(seededPower).toBeGreaterThanOrEqual(250);
    expect(seededPower).toBeLessThanOrEqual(350);
    const generatedWorld = createWorld({ seed: "season-seed", seasonId: "season", startedAt: 1, authorityAccountId: "player" });
    generatedWorld.players.player = { accountId: "player", displayName: "玩家", gold: 500, position: { x: 2, y: 2 }, carriedGeneralIds: [] };
    generatedWorld.privatePlayers.player = { orientation: "any", materials: {} };
    const committed = require("../electron/grid-world-game.cjs").applyIntent(generatedWorld, {
      type: "grant-general", generalId: "generated", name: "初将", gender: "female", coreSetting: "善战。",
      power: 999999, generated: true, powerSeed: "discovery", discoveryId: "discovery", idempotencyKey: "grant-generated"
    }, { actorAccountId: "player", authorityAccountId: "player", now: 2 });
    expect(committed.state.generals.generated.power).toBe(seededPower);
    expect(normalizeGeneratedGeneral({ personaSummary: "名为“茂密”的猫亚人，善于领兵。", appearanceSummary: "白发猫耳。" }, { gender: "female" })).toMatchObject({ name: "茂密", appearanceSetting: "白发猫耳。", coreSetting: expect.stringContaining("善于领兵"), power: 300 });
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
    expect([...new Set(requested)]).toEqual([1, 2, 3]);

    requested.splice(0);
    instance.publicHistoryOrder = history.completeThrough;
    instance.knownCommentIds.add("latest-ordinary");
    await instance.readHistory(false);
    expect(requested).toEqual([3, 1]);
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
    expect([...new Set(requested)].sort()).toEqual([1, 2, 3]);
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
    expect(endpoints.map(endpoint => Number(new URL(`https://test${endpoint}`).searchParams.get("page")))).toEqual([1, 2]);
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
    expect(endpoints).toEqual(["/comments/branches/root", "/comments/work/1?page=4&limit=50&order=desc&filter_type=all"]);
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
    expect(instance.history.stoppedBy).toBe("covered-by-snapshot");
    expect(history.assembled.records.filter((item: any) => item.record.schema === "fyow.world-chat/1")).toHaveLength(0);
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
      expect(requested).toEqual([4]);
      expect(instance.state().worldChat.map((item: any) => item.text)).toEqual(["old-chat"]);

      roots.push(...makeChat("new-chat", 300));
      requested.splice(0);
      const newest = await instance.readWorldChatHistory();
      instance.applyWorldChatRecords(newest.assembled.records);
      expect(newest.pagesScanned).toBe(1);
      expect(requested).toEqual([4]);
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
    const instance = service({ requestConsole: async () => [root], getAccount: () => ({ accountId: "player" }) });
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
    expect(result.marchQuote).toMatchObject({ requestKey: "hover:3,1", from: { x: 1, y: 1 }, to: { x: 3, y: 1 }, distance: 2, soldiers: 5 });
    expect(result.marchQuote.cost).toBeGreaterThan(0);
    expect(result.marchQuote.durationMs).toBeGreaterThan(0);
    expect(JSON.stringify(instance.world)).toBe(before);
    expect(instance.intentInFlight).toBe(pending);
    expect(instance.intentInFlightKey).toBe("pending-action");
    instance.world.bans.player = { banned: true };
    await expect(instance.submitIntent({ type: "quote-march", to: { x: 3, y: 1 }, soldiers: 0 })).rejects.toThrow(/封禁/);
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
    expect(instance.world.privatePlayers.first.materials.white).toBe(1);
    const forged = claim("first", firstIdentity, 400);
    forged.record = signRecord({ ...forged.record, mapDeltaId: "forged-scatter", changes: { ...forged.record.changes, treasureSpawns: { fake: {} } } }, firstIdentity.signingPrivateKey);
    expect(instance.applyMapDelta(forged)).toBe(false);
  });

  it("withholds a newly conquered treasure from cultivation until its public claim survives a complete sync", async () => {
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
    await expect(instance.submitIntent(cultivation)).rejects.toThrow(/素材不足/);
    expect(instance.world.players.player.position).toEqual({ x: 2, y: 1 });
    expect(instance.world.privatePlayers.player.materials.white).toBe(0);
    expect(instance.world.generals.general.cultivationCount).toBe(0);
    const own = assembleCommentRecords(comments).records.find((item: any) => item.record.changes?.claimedTreasures?.["treasure-1"]);
    expect(own).toBeTruthy();
    expect(instance.pendingTreasureRewards()).toHaveLength(1);
    instance.reconcileTreasureRewards({ confirmationComplete: false, assembled: { records: [own], incomplete: [] } });
    expect(instance.world.privatePlayers.player.materials.white).toBe(0);
    instance.reconcileTreasureRewards({ confirmationComplete: true, assembled: { records: [own], incomplete: [] } });
    instance.reconcileTreasureRewards({ confirmationComplete: true, assembled: { records: [own], incomplete: [] } });
    expect(instance.world.privatePlayers.player.materials.white).toBe(1);
    await instance.submitIntent({ ...cultivation, idempotencyKey: "confirmed-cultivate" });
    expect(instance.world.generals.general.cultivationCount).toBe(1);
    expect(instance.world.privatePlayers.player.materials.white).toBe(0);

    comments.splice(0);
    const loser = makeInstance();
    await loser.settleLocalClock();
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
    expect(reader.history.stoppedBy).toBe("covered-by-snapshot");
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

  it("opens a signed cached server and preserves its owner identity during a platform 503", async () => {
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
      const state = await offline.open({ card, displayName: "服主", orientation: "any" });
      expect(state).toMatchObject({
        initialized: true,
        isAuthor: true,
        isServerOwner: true,
        status: "degraded",
        error: "平台请求失败：503",
        work: { id: card.companion.workId, authorAccountId: accountId }
      });
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
    const guest = fixture.create("player");
    guest.requestConsole = requestConsole;
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
      requestConsole: async () => { throw new Error("comment write failed"); }
    });
    instance.work = { id: "work", authorAccountId: "authority" };
    instance.control = { seasonId: "season", authorityAccountId: "authority" };
    instance.world = world;
    await expect(instance.submitIntent({ type: "deploy-general", generalId: "g1", idempotencyKey: "deploy" })).rejects.toThrow(/comment write failed/);
    expect(instance.world.generals.g1.status).toBe("carried");
    expect(instance.world.players.player.carriedGeneralIds).toEqual(["g1"]);
    expect(instance.world.cells["1,1"].generalIds).toEqual([]);
    expect(instance.localEvents).toHaveLength(0);
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
    const exportData = { name: "艳猎征途", desc: "program", prpt: "world", pretxt: "prefix", posttxt: "post", world_book: [] };
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
      world_book: [],
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
