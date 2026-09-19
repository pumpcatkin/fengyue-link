import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { OnlineWorldService } = require("../electron/online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("../electron/online-world-crypto.cjs");
const { canonicalJson, createResetDirective, encodeCommentRecord, sha256, signRecord } = require("../electron/online-world-protocol.cjs");
const { createWorld } = require("../electron/grid-world-game.cjs");

function methodBody(source: string, signature: string, nextSignature: string) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const method = source.slice(start, end);
  const bodyStart = method.indexOf(") {");
  expect(bodyStart).toBeGreaterThanOrEqual(0);
  return method.slice(bodyStart + 3, method.lastIndexOf("}"));
}

function migrationFixture({ valid = true } = {}) {
  const identity = generateOnlineWorldIdentity();
  const instance = new OnlineWorldService({
    getAccount: () => ({ accountId: "author", username: "服主" }),
    getIdentity: async () => identity,
    getOrigin: () => "https://aigirlfriend.baby",
    requestConsole: async () => ({ data: [] }),
    cacheFile: null,
    onChange: () => {}
  });
  instance.work = { id: "old-work", authorAccountId: "author" };
  const reset = createResetDirective({
    gameId: "cc.aiero.fyow.grid-conquest",
    seasonId: "season-1",
    oldWorkId: "old-work",
    newWorkId: "new-work",
    newWorkUrl: "https://aigirlfriend.baby/zh/explore/installed/new-work",
    exportSha256: "a".repeat(64),
    authorityAccountId: "author",
    authoritySigningPublicKey: valid ? identity.signingPublicKey : "forged-key"
  });
  const signed = signRecord(reset, identity.signingPrivateKey);
  instance.readHistory = vi.fn(async () => ({
    assembled: {
      records: [{
        record: signed,
        sources: [{ id: "reset-comment", account_id: "author", created_at: 2_000 }]
      }]
    }
  }));
  return { instance, reset, identity };
}

describe("online world migration regressions", () => {
  it("follows an A-to-B-to-C migration chain and persists only the final server", async () => {
    const main = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const body = methodBody(main, "async followOnlineWorldMigrationChain(", "async migrateOnlineWorldCard(");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const followChain = new AsyncFunction(
      "current",
      "initialMigration",
      "options",
      "rebindGameCard",
      "gameCardLibraryKey",
      "validateGameCard",
      "saveGameCardLibrary",
      body
    );
    const card = { cardId: "grid-card", companion: { workId: "A" } };
    const opened: Array<{ workId: string; proofSource: string }> = [];
    const cleared: string[] = [];
    let saves = 0;
    const onlineWorldService: any = {
      card,
      async open({ card: nextCard, migrationProof }: any) {
        const workId = String(nextCard.companion.workId);
        opened.push({ workId, proofSource: String(migrationProof.sourceWorkId) });
        this.card = nextCard;
        if (workId === "B") {
          return {
            initialized: false,
            work: { id: "B" },
            migration: { sourceWorkId: "B", workId: "C", targetControlId: "control-C" }
          };
        }
        return { initialized: true, work: { id: "C" }, migration: null };
      },
      clearCacheForWork(workId: string) { cleared.push(workId); }
    };
    const backend: any = {
      origin: "https://aigirlfriend.baby",
      onlineWorldService,
      onlineWorldCardFile: "fixture.json",
      onlineWorldCards: new Map([["grid-card::A", card]])
    };
    const rebind = (source: any, workId: string) => ({
      ...source,
      companion: { ...source.companion, workId }
    });
    const key = (value: any) => `${value.cardId}::${value.companion.workId}`;

    const result = await followChain.call(
      backend,
      card,
      { sourceWorkId: "A", workId: "B", targetControlId: "control-B" },
      { displayName: "旧玩家" },
      rebind,
      key,
      (value: any) => value,
      () => { saves += 1; }
    );

    expect(result).toMatchObject({ initialized: true, work: { id: "C" } });
    expect(opened).toEqual([
      { workId: "B", proofSource: "A" },
      { workId: "C", proofSource: "B" }
    ]);
    expect([...backend.onlineWorldCards.keys()]).toEqual(["grid-card::C"]);
    expect(cleared.sort()).toEqual(["A", "B"]);
    expect(saves).toBe(1);
  });

  it("keeps a validated target-bound card instead of downgrading it from an old JSON card", async () => {
    const main = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const body = methodBody(main, "async followOnlineWorldMigrationChain(", "async migrateOnlineWorldCard(");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const followChain = new AsyncFunction(
      "current",
      "initialMigration",
      "options",
      "rebindGameCard",
      "gameCardLibraryKey",
      "validateGameCard",
      "saveGameCardLibrary",
      body
    );
    const oldCard = {
      cardId: "grid-card",
      gameId: "grid-game",
      version: 26,
      companion: { workId: "old-work", authorAccountId: "author", origin: "https://aigirlfriend.baby" },
      configurationMarker: "old-json"
    };
    const targetCard = {
      ...oldCard,
      version: 27,
      companion: { ...oldCard.companion, workId: "target-work" },
      configurationMarker: "target-export"
    };
    const opened: any[] = [];
    let saves = 0;
    const onlineWorldService: any = {
      card: oldCard,
      async open({ card }: any) {
        opened.push(card);
        this.card = card;
        return { initialized: true, work: { id: "target-work" }, migration: null };
      },
      clearCacheForWork() {}
    };
    const key = (value: any) => `${value.cardId}::${value.companion.workId}`;
    const backend: any = {
      origin: "https://aigirlfriend.baby",
      onlineWorldService,
      onlineWorldCardFile: "fixture.json",
      onlineWorldCards: new Map([
        [key(oldCard), oldCard],
        [key(targetCard), targetCard]
      ])
    };
    const rebind = (source: any, workId: string, origin: string) => ({
      ...source,
      companion: { ...source.companion, workId, origin }
    });
    const validate = vi.fn((value: any) => ({ ...value, companion: { ...value.companion } }));

    await followChain.call(
      backend,
      oldCard,
      { sourceWorkId: "old-work", workId: "target-work", targetControlId: "target-control" },
      { displayName: "旧玩家" },
      rebind,
      key,
      validate,
      () => { saves += 1; }
    );

    expect(validate).toHaveBeenCalledWith(targetCard);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ version: 27, configurationMarker: "target-export" });
    expect([...backend.onlineWorldCards.keys()]).toEqual(["grid-card::target-work"]);
    expect(backend.onlineWorldCards.get("grid-card::target-work")).toMatchObject({
      version: 27,
      configurationMarker: "target-export"
    });
    expect(saves).toBe(1);
  });

  it("finds a signed migration marker when the old ledger has been purged", async () => {
    const { instance } = migrationFixture();
    try {
      const state = await instance.syncNow(true);
      expect(state.status).toBe("migrating");
      expect(state.migration).toMatchObject({
        sourceWorkId: "old-work",
        workId: "new-work",
        resetId: expect.any(String)
      });
      expect(instance.control).toBeNull();
      expect(instance.world).toBeNull();
    } finally {
      instance.close();
    }
  });

  it("keeps an owner's cleanup retry state when the reset marker is polled again", async () => {
    const { instance, reset } = migrationFixture();
    instance.pendingMigration = {
      workId: "new-work",
      resetId: reset.resetId,
      requiresPublish: true,
      redirectPublished: true,
      cleanupPending: true,
      cleanup: { attempted: 4, deleted: 3, failures: [{ id: "late-comment", error: "retry" }] }
    };
    try {
      const state = await instance.syncNow(true);
      expect(state.migration).toMatchObject({
        workId: "new-work",
        resetId: reset.resetId,
        requiresPublish: true,
        redirectPublished: true,
        cleanupPending: true,
        cleanup: { attempted: 4, deleted: 3 }
      });
    } finally {
      instance.close();
    }
  });

  it("retains the cached source ledger so the owner can resume cleanup after restart", async () => {
    const { instance, reset, identity } = migrationFixture();
    instance.control = {
      id: "source-control",
      gameId: "cc.aiero.fyow.grid-conquest",
      workId: "old-work",
      seasonId: "season-1",
      authorityAccountId: "author",
      authoritySigningPublicKey: identity.signingPublicKey
    };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season-1" });
    instance.migrationDraft = { sourceWorkId: "old-work", newWorkId: "new-work", resetId: reset.resetId };
    instance.pendingMigration = { workId: "new-work", resetId: reset.resetId, requiresPublish: true };
    try {
      const state = await instance.syncNow(true);
      expect(state.migration).toMatchObject({ workId: "new-work", requiresPublish: true, cleanupPending: true });
      expect(instance.control?.id).toBe("source-control");
      expect(instance.world?.seasonId).toBe("season-1");
      expect(instance.isAuthority()).toBe(true);
    } finally {
      instance.close();
    }
  });

  it("does not create another target when the source history cannot be read", async () => {
    const identity = generateOnlineWorldIdentity();
    let targetCreates = 0;
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      getOrigin: () => "https://aigirlfriend.baby",
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps" && options.method === "POST") targetCreates += 1;
        return { data: [] };
      },
      cacheFile: null,
      onChange: () => {}
    });
    instance.work = { id: "old", name: "猎艳疆土", authorAccountId: "author" };
    instance.control = {
      id: "control", seasonId: "season", authorityAccountId: "author",
      authoritySigningPublicKey: identity.signingPublicKey
    };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.readAllCommentSources = vi.fn(async () => { throw new Error("fixture history unavailable"); });
    try {
      await expect(instance.exportMigrationDraft()).rejects.toThrow(/history unavailable/);
      expect(targetCreates).toBe(0);
      expect(instance.migrationDraft).toBeNull();
    } finally {
      instance.close();
    }
  });

  it("blocks an action that was waiting for sync when migration starts", async () => {
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "player", username: "玩家" }),
      requestConsole: async () => ({ data: [] }),
      onChange: () => {}
    });
    instance.work = { id: "work", authorAccountId: "author" };
    instance.control = { seasonId: "season", authorityAccountId: "author" };
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.status = "ready";
    let releaseSync!: () => void;
    instance.syncInFlight = new Promise<void>(resolve => { releaseSync = resolve; });
    instance.submitIntentNow = vi.fn(async () => ({ ok: true }));
    const action = instance.submitIntent({ type: "fixture", idempotencyKey: "fixture" });
    instance.migrationActive = true;
    releaseSync();
    try {
      await expect(action).rejects.toThrow(/正在搬迁/);
      expect(instance.submitIntentNow).not.toHaveBeenCalled();
    } finally {
      instance.migrationActive = false;
      instance.syncInFlight = null;
      instance.close();
    }
  });

  it("enumerates every root branch during destructive migration cleanup", async () => {
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "author" }),
      requestConsole: async () => ({ data: [] }),
      onChange: () => {}
    });
    instance.work = { id: "old", authorAccountId: "author" };
    instance.readHistoryPage = vi.fn(async () => [{ id: "root", content: "root" }]);
    instance.readCommentBranches = vi.fn(async () => [{ id: "reply", parent_id: "root", content: "reply" }]);
    try {
      const comments = await instance.readAllCommentSources({ includeAllBranches: true });
      expect(comments.map((item: any) => item.id)).toEqual(["root", "reply"]);
      expect(instance.readCommentBranches).toHaveBeenCalledWith("root", expect.any(Number), expect.any(Object));
    } finally {
      instance.close();
    }
  });

  it("re-publishes the target snapshot when the source watermark changes, then waits for quiescence", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      getOrigin: () => "https://aigirlfriend.baby",
      requestConsole: async () => ({ data: [] }),
      cacheFile: null,
      onChange: () => {}
    });
    const oldWork = { id: "old", authorAccountId: "author" };
    const newWork = { id: "new", authorAccountId: "author" };
    const oldControl = { id: "old-control", seasonId: "season" };
    const newControl = { id: "new-control", seasonId: "season" };
    instance.work = oldWork;
    instance.control = oldControl;
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    const draft: any = {
      targetSourceWatermark: "stale",
      sourceLedgerRuntime: instance.captureLedgerRuntimeState()
    };
    instance.syncNow = vi.fn(async () => instance.state());
    instance.publishSnapshot = vi.fn(async () => ({ snapshotId: "fresh-snapshot" }));
    instance.verifyMigrationTargetLedger = vi.fn(async () => ({ verified: true }));
    instance.saveMigrationDraftForSource = vi.fn();
    try {
      await expect(instance.settleMigratedSource(
        draft,
        newWork,
        newControl,
        oldWork,
        oldControl,
        { rounds: 3, settleDelayMs: 0, quiescenceMs: 0 }
      )).resolves.toBe(true);
      expect(instance.publishSnapshot).toHaveBeenCalledTimes(1);
      expect(instance.verifyMigrationTargetLedger).toHaveBeenCalledTimes(1);
      expect(draft).toMatchObject({
        targetSnapshotId: "fresh-snapshot",
        targetLedgerInitialized: true,
        sourceFinalizedAfterReset: true
      });
    } finally {
      instance.close();
    }
  });

  it("ignores a migration marker signed by a different authority", async () => {
    const { instance } = migrationFixture({ valid: false });
    try {
      const state = await instance.syncNow(true);
      expect(state.status).toBe("needs-initialization");
      expect(state.migration).toBeNull();
    } finally {
      instance.close();
    }
  });

  it("clears only the current account's cache for the retired work", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-migration-cache-"));
    const cacheFile = path.join(directory, "cache.json");
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({
        version: 2,
        accounts: {
          player: { worlds: { "old-work": { cacheAccountId: "player" }, "keep-work": { cacheAccountId: "player" } } },
          other: { worlds: { "old-work": { cacheAccountId: "other" } } }
        },
        legacyWorlds: {}
      }));
      const instance = new OnlineWorldService({
        getAccount: () => ({ accountId: "player" }),
        requestConsole: async () => ({ data: [] }),
        cacheFile,
        onChange: () => {}
      });
      expect(instance.clearCacheForWork("old-work")).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      expect(persisted.accounts.player.worlds["old-work"]).toBeUndefined();
      expect(persisted.accounts.player.worlds["keep-work"]).toBeDefined();
      expect(persisted.accounts.other.worlds["old-work"]).toBeDefined();
      instance.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("purges old comments while preserving the signed migration marker", async () => {
    const deleted: string[] = [];
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "author" }),
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (options.method === "DELETE") deleted.push(endpoint);
        return { ok: true };
      },
      onChange: () => {}
    });
    instance.work = { id: "old-work", authorAccountId: "author" };
    try {
      const result = await instance.purgeWorkComments([
        { id: "root" },
        { id: "reply" },
        { id: "reply" },
        { id: "marker" }
      ], new Set(["marker"]));
      expect(result).toMatchObject({ attempted: 2, deleted: 2, failures: [] });
      expect(deleted).toEqual([
        "/comments/old-work/1/reply",
        "/comments/old-work/1/root"
      ]);
      expect(deleted).not.toContain("/comments/old-work/1/marker");
    } finally {
      instance.close();
    }
  });

  it("reads back and verifies the exact target control and snapshot before retirement", async () => {
    const identity = generateOnlineWorldIdentity();
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "author" }),
      getIdentity: async () => identity,
      requestConsole: async () => ({ ok: true }),
      onChange: () => {}
    });
    const oldWork = { id: "old", authorAccountId: "author" };
    const newWork = { id: "new", authorAccountId: "author" };
    const oldControl = { id: "old-control", authoritySigningPublicKey: identity.signingPublicKey };
    const newControl = signRecord({
      schema: "fyow.control/3",
      id: "new-control",
      gameId: "cc.aiero.fyow.grid-conquest",
      workId: "new",
      seasonId: "season",
      programHash: "program",
      authorityAccountId: "author",
      authoritySigningPublicKey: identity.signingPublicKey,
      authorityEncryptionPublicKey: identity.encryptionPublicKey,
      startedAt: 1,
      updatedAt: 2
    }, identity.signingPrivateKey);
    const snapshotState = { gameId: "cc.aiero.fyow.grid-conquest", seasonId: "season", revision: 1 };
    const snapshot = signRecord({
      schema: "fyow.snapshot/3",
      snapshotId: "target-snapshot",
      gameId: "cc.aiero.fyow.grid-conquest",
      workId: "new",
      seasonId: "season",
      revision: 1,
      state: snapshotState,
      stateHash: sha256(Buffer.from(canonicalJson(snapshotState))),
      createdAt: 2
    }, identity.signingPrivateKey);
    const sources = [newControl, snapshot].flatMap((record: any, recordIndex: number) =>
      encodeCommentRecord(record).map((content: string, index: number) => ({
        id: `record-${recordIndex}-${index}`,
        account_id: "author",
        created_at: 2_000 + recordIndex * 10 + index,
        content
      })));
    instance.work = oldWork;
    instance.control = oldControl;
    instance.world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    instance.readAllCommentSources = vi.fn(async () => sources);
    instance.postRecord = vi.fn(async () => { throw new Error("verified records must not be reposted"); });
    const draft = { targetSnapshotId: snapshot.snapshotId, targetLedgerVerified: false };
    try {
      await instance.verifyMigrationTargetLedger(draft, newWork, newControl, oldWork, oldControl, {
        allowRepair: false,
        attempts: 1,
        retryDelayMs: 0
      });
      expect(draft.targetLedgerVerified).toBe(true);
      expect(instance.postRecord).not.toHaveBeenCalled();

      instance.readAllCommentSources = vi.fn(async () => sources.filter(item => !item.id.startsWith("record-1-")));
      await expect(instance.verifyMigrationTargetLedger(
        { targetSnapshotId: snapshot.snapshotId },
        newWork,
        newControl,
        oldWork,
        oldControl,
        { allowRepair: false, attempts: 1, retryDelayMs: 0 }
      )).rejects.toThrow(/初始快照尚未回读/);
    } finally {
      instance.close();
    }
  });

  it("retains local private player state while changing the bound work", () => {
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "player" }),
      requestConsole: async () => ({ ok: true }),
      onChange: () => {}
    });
    const source = createWorld({ authorityAccountId: "author", seasonId: "season" });
    source.players.player = {
      accountId: "player",
      displayName: "玩家",
      gold: 321,
      fieldArmySoldiers: 45,
      carriedGeneralIds: ["general"],
      position: { x: 3, y: 4 },
      basePower: 300,
      trainingLevel: 2,
      power: 330
    };
    source.playerEpochs.player = 0;
    source.privatePlayers.player = { materials: { cinnabar: 2 }, playerContext: { setting: "本地设定" } };
    source.generals.general = { id: "general", name: "随将", holderAccountId: "player", status: "carried", power: 300 };
    source.jobs.job = { id: "job", accountId: "player", type: "march" };
    instance.world = source;
    instance.localEvents = [{ id: "event", actorAccountId: "player" }];
    instance.directHistory = [{ messageId: "letter", direction: "out" }];
    instance.directInbox = [];
    instance.seenDirectMessageIds.add("letter");
    instance.localPreferences.playerContext = { setting: "本地设定" };
    const carried = instance.captureMigrationLocalState();
    instance.work = { id: "old", authorAccountId: "author" };
    instance.world = null;
    instance.loadCache = vi.fn(() => ({
      localOverlay: carried.overlay,
      localEvents: carried.localEvents,
      localPreferences: carried.localPreferences,
      directInbox: carried.directInbox,
      directHistory: carried.directHistory,
      seenDirectMessageIds: carried.seenDirectMessageIds,
      pendingModelEffects: carried.pendingModelEffects
    }));
    const carriedFromTombstone = instance.captureMigrationLocalState();
    expect(carriedFromTombstone.overlay.players.player.gold).toBe(321);

    const target = createWorld({ authorityAccountId: "author", seasonId: "season" });
    target.players.player = { accountId: "player", displayName: "玩家" };
    target.playerEpochs.player = 0;
    instance.world = target;
    instance.localEvents = [];
    instance.directHistory = [];
    instance.seenDirectMessageIds.clear();
    try {
      expect(instance.restoreMigrationLocalState(carriedFromTombstone)).toBe(true);
      expect(instance.world.players.player).toMatchObject({ gold: 321, fieldArmySoldiers: 45, position: { x: 3, y: 4 } });
      expect(instance.world.privatePlayers.player.materials).toEqual({ cinnabar: 2 });
      expect(instance.world.generals.general.name).toBe("随将");
      expect(instance.world.jobs.job.type).toBe("march");
      expect(instance.localEvents).toHaveLength(1);
      expect(instance.directHistory[0].messageId).toBe("letter");
      expect(instance.seenDirectMessageIds.has("letter")).toBe(true);
    } finally {
      instance.close();
    }
  });

  it("resumes an interrupted migration draft without creating or publishing the target twice", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-migration-resume-"));
    const cacheFile = path.join(directory, "cache.json");
    const identity = generateOnlineWorldIdentity();
    const exportData = {
      name: "猎艳疆土",
      desc: "program",
      prpt: "world",
      pretxt: "prefix",
      posttxt: "post",
      world_book: []
    };
    let oldSavedName = "";
    let failImport = true;
    let failReset = true;
    let appCreates = 0;
    let targetRootPosts = 0;
    let commentSequence = 0;
    const requestConsole = async (endpoint: string, options: any = {}) => {
      if (endpoint === "/apps/old/model-config/export") {
        return { data: oldSavedName ? { ...exportData, name: oldSavedName } : exportData };
      }
      if (endpoint === "/apps" && options.method === "POST") {
        appCreates += 1;
        return { data: { app: { id: "new" } } };
      }
      if (endpoint === "/apps/new/model-config" && options.method === "POST") {
        if (failImport) throw new Error("fixture configuration import interrupted");
        return { ok: true };
      }
      if (endpoint === "/apps/new/model-config/export") return { data: exportData };
      if (endpoint === "/apps/old/model-config" && options.method === "POST") {
        oldSavedName = String(options.body.app.name);
        return { ok: true };
      }
      if (endpoint === "/comments/old/1" && options.method === "POST" && failReset) {
        throw new Error("fixture reset publication interrupted");
      }
      if (endpoint === "/comments/new/1" && options.method === "POST" && !options.body.parent_id) {
        targetRootPosts += 1;
      }
      if (endpoint.startsWith("/comments/") && options.method === "POST") {
        commentSequence += 1;
        return {
          id: `comment-${commentSequence}`,
          account_id: "author",
          created_at: 2_000 + commentSequence,
          ...options.body
        };
      }
      throw new Error(`unexpected migration endpoint ${endpoint}`);
    };
    const oldWork = { id: "old", name: "猎艳疆土", description: "program", authorAccountId: "author" };
    const makeService = () => {
      const instance = new OnlineWorldService({
        getAccount: () => ({ accountId: "author", username: "服主" }),
        getIdentity: async () => identity,
        getOrigin: () => "https://aigirlfriend.baby",
        requestConsole,
        cacheFile,
        onChange: () => {}
      });
      instance.verifyMigrationTargetLedger = vi.fn(async (draft: any) => {
        draft.targetLedgerVerified = true;
        return { verified: true };
      });
      instance.syncNow = vi.fn(async () => instance.state());
      instance.settleMigratedSource = vi.fn(async (draft: any) => {
        draft.sourceFinalizedAfterReset = true;
        return true;
      });
      instance.compactMigratedSource = vi.fn(async () => ({
        attempted: 0, deleted: 0, failures: [], verified: true, remaining: []
      }));
      return instance;
    };
    const first = makeService();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    const control = signRecord({
      schema: "fyow.control/3",
      id: "control-old",
      gameId: "cc.aiero.fyow.grid-conquest",
      workId: "old",
      seasonId: "season",
      programHash: first.currentProgramHash(),
      authorityAccountId: "author",
      authoritySigningPublicKey: identity.signingPublicKey,
      authorityEncryptionPublicKey: identity.encryptionPublicKey,
      startedAt: world.startedAt,
      updatedAt: world.startedAt
    }, identity.signingPrivateKey);
    first.work = oldWork;
    first.control = control;
    first.world = world;
    first.readAllCommentSources = vi.fn(async () => []);

    try {
      const importInterrupted = await first.exportMigrationDraft();
      expect(importInterrupted).toMatchObject({
        workId: "new",
        configurationImported: false,
        redirectPublished: false
      });
      expect(appCreates).toBe(1);
      expect(targetRootPosts).toBe(0);

      const importDraft = first.loadCache("old")?.migrationDraft;
      expect(importDraft).toMatchObject({ sourceWorkId: "old", newWorkId: "new", configurationImported: false });
      const resetId = importDraft.resetId;

      failImport = false;
      const ledgerResume = makeService();
      ledgerResume.work = oldWork;
      ledgerResume.control = control;
      ledgerResume.world = world;
      ledgerResume.migrationDraft = importDraft;
      ledgerResume.readAllCommentSources = vi.fn(async () => []);
      try {
        const resetInterrupted = await ledgerResume.exportMigrationDraft();
        expect(resetInterrupted).toMatchObject({
          workId: "new",
          configurationImported: true,
          newLedgerInitialized: true,
          redirectPublished: false,
          resetId
        });
        expect(appCreates).toBe(1);
        expect(targetRootPosts).toBe(2);
      } finally { ledgerResume.syncPaused = true; }

      const ledgerDraft = first.loadCache("old")?.migrationDraft;
      expect(ledgerDraft).toMatchObject({
        newWorkId: "new",
        configurationImported: true,
        targetControlPosted: true,
        targetLedgerInitialized: true,
        resetId
      });

      failReset = false;
      const redirectResume = makeService();
      redirectResume.work = oldWork;
      redirectResume.control = control;
      redirectResume.world = world;
      redirectResume.migrationDraft = ledgerDraft;
      redirectResume.readAllCommentSources = vi.fn(async () => []);
      try {
        const completed = await redirectResume.exportMigrationDraft();
        expect(completed).toMatchObject({ workId: "new", redirectPublished: true, resetId });
        expect(appCreates).toBe(1);
        expect(targetRootPosts).toBe(2);
        expect(redirectResume.migrationDraft).toBeNull();
      } finally { redirectResume.close(); }
    } finally {
      first.syncPaused = true;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("reuses the created target when configuration import is retried", async () => {
    const identity = generateOnlineWorldIdentity();
    const world = createWorld({ authorityAccountId: "author", seasonId: "season" });
    const exportData = {
      name: "猎艳疆土",
      desc: "program",
      prpt: "world",
      pretxt: "prefix",
      posttxt: "post",
      world_book: []
    };
    let appCreates = 0;
    let rejectImport = true;
    let oldSavedName = "";
    let commentSequence = 0;
    const instance = new OnlineWorldService({
      getAccount: () => ({ accountId: "author", username: "服主" }),
      getIdentity: async () => identity,
      getOrigin: () => "https://aigirlfriend.baby",
      requestConsole: async (endpoint: string, options: any = {}) => {
        if (endpoint === "/apps/old/model-config/export") {
          return { data: oldSavedName ? { ...exportData, name: oldSavedName } : exportData };
        }
        if (endpoint === "/apps" && options.method === "POST") {
          appCreates += 1;
          return { data: { app: { id: "new" } } };
        }
        if (endpoint === "/apps/new/model-config" && options.method === "POST") {
          if (rejectImport) throw new Error("fixture import interrupted");
          return { ok: true };
        }
        if (endpoint === "/apps/new/model-config/export") return { data: exportData };
        if (endpoint === "/apps/old/model-config" && options.method === "POST") {
          oldSavedName = String(options.body.app.name);
          return { ok: true };
        }
        if (endpoint.startsWith("/comments/") && options.method === "POST") {
          commentSequence += 1;
          return { id: `comment-${commentSequence}`, account_id: "author", created_at: 3_000 + commentSequence, ...options.body };
        }
        throw new Error(`unexpected migration endpoint ${endpoint}`);
      },
      onChange: () => {}
    });
    instance.work = { id: "old", name: "猎艳疆土", description: "program", authorAccountId: "author" };
    instance.control = signRecord({
      schema: "fyow.control/3",
      id: "control-old",
      gameId: "cc.aiero.fyow.grid-conquest",
      workId: "old",
      seasonId: "season",
      programHash: instance.currentProgramHash(),
      authorityAccountId: "author",
      authoritySigningPublicKey: identity.signingPublicKey,
      authorityEncryptionPublicKey: identity.encryptionPublicKey,
      startedAt: world.startedAt,
      updatedAt: world.startedAt
    }, identity.signingPrivateKey);
    instance.world = world;
    instance.readAllCommentSources = vi.fn(async () => []);
    instance.verifyMigrationTargetLedger = vi.fn(async (draft: any) => {
      draft.targetLedgerVerified = true;
      return { verified: true };
    });
    instance.syncNow = vi.fn(async () => instance.state());
    instance.settleMigratedSource = vi.fn(async (draft: any) => {
      draft.sourceFinalizedAfterReset = true;
      return true;
    });
    instance.compactMigratedSource = vi.fn(async () => ({
      attempted: 0, deleted: 0, failures: [], verified: true, remaining: []
    }));
    try {
      const interrupted = await instance.exportMigrationDraft();
      expect(interrupted).toMatchObject({ workId: "new", requiresConfigurationImport: true, redirectPublished: false });
      expect(instance.migrationDraft).toMatchObject({ newWorkId: "new", configurationImported: false });
      expect(appCreates).toBe(1);

      rejectImport = false;
      const completed = await instance.exportMigrationDraft();
      expect(completed.importError).toBeUndefined();
      expect(completed).toMatchObject({ workId: "new", configurationImported: true, redirectPublished: true });
      expect(appCreates).toBe(1);
    } finally {
      instance.close();
    }
  }, 15_000);
});
