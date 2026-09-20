import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  GAME_CARD_SCHEMA,
  GRID_CARD_ID,
  GRID_COMPANION_WORK_ID,
  GRID_COMPANION_INSTANCE_ID,
  createBundledGridCard,
  normalizeProgramText,
  createExportedGameCard,
  refreshGameCardProgram,
  validateGameCard,
  rebindGameCard,
  gameCardLibraryKey,
  summarizeGameCard,
  loadGameCardLibrary,
  saveGameCardLibrary,
  readGameCardFile,
  scanGameCardDirectory,
  removeGameCardDirectoryFiles
} = require("../electron/online-world-card.cjs");
const { packProgram, parseProgram } = require("../electron/online-world-runtime.cjs");

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("online world game cards", () => {
  it("packs the same game program from LF and Windows CRLF sources", () => {
    expect(normalizeProgramText("界面\r\n样式\r脚本")).toBe("界面\n样式\n脚本");
    const card = createBundledGridCard();
    expect(parseProgram(card.companion.configuration.app.description, card.gameId).digest).toBe(card.program.digest);
  });

  it("ships one fixed companion work and its complete creation-page snapshot", () => {
    const card = validateGameCard(createBundledGridCard());
    expect(card.schema).toBe(GAME_CARD_SCHEMA);
    expect(card.cardId).toBe(GRID_CARD_ID);
    expect(card.companion.workId).toBe(GRID_COMPANION_WORK_ID);
    expect(GRID_COMPANION_INSTANCE_ID).toMatch(/^[0-9a-f]{16}$/);
    expect(card.title).toBe("猎艳疆土");
    expect(card.version).toBe(31);
    expect(card.companion.authorAccountId).toBe("39404f0e-7678-45a1-86c6-9a21116bacbd");
    expect(card.companion.configuration.app.name).toBe(`猎艳疆土[${GRID_COMPANION_INSTANCE_ID}]`);
    expect(card.companion.configuration.app.id).toBe(GRID_COMPANION_WORK_ID);
    expect(card.companion.configuration.app.summary).toContain("64×64");
    expect(card.companion.configuration.app.description).toContain("[[FYOW-PROGRAM/1:");
    const embeddedProgram = parseProgram(card.companion.configuration.app.description, card.gameId);
    expect(embeddedProgram.html).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=/i);
    expect(embeddedProgram.html).toContain("#f4dfad");
    expect(card.companion.configuration.pre_text).toContain("结构化任务引擎");
    expect(card.companion.configuration.pre_prompt).toContain("只有天生拥有“慧眼”");
    expect(card.companion.configuration.post_text).toContain("单个 JSON 对象");
    expect(card.companion.configuration.post_text).toContain("合理补全");
    expect(card.companion.configuration.world_book).toHaveLength(7);
    expect(card.companion.configuration.world_book.map((entry: any) => entry.key)).toEqual([
      "_or_[[FYOW:TASK:general.generate:v1]]",
      "_or_[[FYOW:TASK:player.profile-context:v1]]",
      "_or_[[FYOW:TASK:general.dialogue:v1]]",
      "_or_[[FYOW:TASK:general.captive-dialogue:v1]]",
      "_or_[[FYOW:TASK:general.memory.update:v1]]",
      "_or_[[FYOW:TASK:general.letter:v1]]",
      "_or_[[FYOW:TASK:general.appearance-edit:v1]]"
    ]);
    expect(card.companion.configuration.world_book.every((entry: any) => entry.key_region === 2 && entry.enable === true && entry.probability === 100)).toBe(true);
    expect(card.companion.configuration.world_book[2].value).toContain("最多 180 个汉字");
    expect(card.companion.configuration.world_book[3].value).toContain("最多 180 个汉字");
    expect(card.companion.configuration.world_book[0].value).toContain("initialWish 是最高优先级");
    expect(card.companion.configuration.world_book[0].value).toContain("appearanceSetting");
    expect(card.companion.configuration.world_book[0].value).toContain("coreSetting");
    expect(card.companion.configuration.world_book[0].value).toContain("长度自由");
    expect(card.companion.configuration.world_book[1].value).toContain("禁止出现未提供");
    expect(card.companion.configuration.world_book[2].value).toContain("recipientKey");
    expect(card.companion.configuration.world_book[3].value).toContain("不得输出其他游戏操作或任何账号编号");
    expect(card.companion.configuration.world_book[4].value).toContain("不得改写或遗漏");
    expect(card.companion.configuration.world_book[5].value).toContain("interactionHistory");
    expect(card.companion.configuration.world_book[6].value).toContain("changeNote");
  });

  it("rejects edits to either the creation snapshot or the whole package", () => {
    const modifiedSnapshot = createBundledGridCard();
    modifiedSnapshot.companion.configuration.pre_prompt = "伪造世界观";
    expect(() => validateGameCard(modifiedSnapshot)).toThrow(/配置快照校验失败/);

    const modifiedMetadata = createBundledGridCard();
    modifiedMetadata.title = "伪造标题";
    expect(() => validateGameCard(modifiedMetadata)).toThrow(/整包校验失败/);
  });

  it("exports a live creation-page snapshot and preserves it through the local library", () => {
    const original = createBundledGridCard();
    const live = {
      nm: `艳猎征途[${GRID_COMPANION_INSTANCE_ID}]`,
      summary: "64×64 持久在线策略世界",
      desc: original.companion.configuration.app.description,
      pretxt: original.companion.configuration.pre_text,
      pre_pt: `${original.companion.configuration.pre_prompt}\n已由创作页回读。`,
      potx: original.companion.configuration.post_text,
      wbook: original.companion.configuration.world_book,
      built_in_css: "body{color:#fff}",
      ext_cfg: { fixture: true }
    };
    const exported = validateGameCard(createExportedGameCard(original, live, "2026-09-12T00:00:00.000Z"));
    expect(exported.companion.configuration.pre_prompt).toContain("已由创作页回读");
    expect(exported.companion.configuration.built_in_css).toBe("body{color:#fff}");
    expect(exported.companion.configuration.ext_cfg).toEqual({ fixture: true });

    const directory = mkdtempSync(join(tmpdir(), "fyow-card-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cards.json");
    const cards = new Map([[exported.cardId, exported]]);
    saveGameCardLibrary(file, cards);
    const loaded = loadGameCardLibrary(file, original);
    expect(loaded.get(exported.cardId).packageSha256).toBe(exported.packageSha256);
  });

  it("replaces only the embedded program when a companion description is refreshed", () => {
    const original = createBundledGridCard();
    const packed = packProgram({
      gameId: original.gameId,
      title: "猎艳疆土",
      html: "<!doctype html><html><body>latest companion program</body></html>"
    });
    const refreshed = validateGameCard(refreshGameCardProgram(original, packed.envelope, "2026-09-20T00:00:00.000Z"));
    expect(refreshed.program.digest).toBe(packed.digest);
    expect(refreshed.packageSha256).not.toBe(original.packageSha256);
    expect(refreshed.companion.configuration.app.description).toBe(packed.envelope);
    expect(refreshed.companion.configuration.pre_prompt).toBe(original.companion.configuration.pre_prompt);
    expect(refreshed.companion.configuration.world_book).toEqual(original.companion.configuration.world_book);
    expect(refreshed.exportedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("updates legacy description aliases so a refreshed card survives restart validation", () => {
    const original = createBundledGridCard();
    const aliased = createExportedGameCard(original, {
      ...original.companion.configuration,
      desc: original.companion.configuration.app.description
    });
    const latest = packProgram({
      gameId: original.gameId,
      title: "猎艳疆土",
      html: "<!doctype html><html><body>alias refresh</body></html>"
    });
    const refreshed = validateGameCard(refreshGameCardProgram(aliased, latest.envelope));
    expect(refreshed.companion.configuration.desc).toBe(latest.envelope);
    const directory = mkdtempSync(join(tmpdir(), "fyow-card-program-refresh-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cards.json");
    const libraryId = gameCardLibraryKey(refreshed);
    saveGameCardLibrary(file, new Map([[libraryId, refreshed]]));
    expect(loadGameCardLibrary(file, null).get(libraryId)?.program.digest).toBe(latest.digest);
  });

  it("starts an external-only library empty and preserves cards imported later", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-external-card-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cards.json");
    expect(loadGameCardLibrary(file, null).size).toBe(0);

    const imported = createBundledGridCard();
    const libraryId = gameCardLibraryKey(imported);
    saveGameCardLibrary(file, new Map([[libraryId, imported]]));
    const afterRestart = loadGameCardLibrary(file, null);
    expect(afterRestart.get(libraryId)?.packageSha256).toBe(imported.packageSha256);

    Map.prototype.delete.call(afterRestart, libraryId);
    saveGameCardLibrary(file, afterRestart);
    expect(loadGameCardLibrary(file, null).has(libraryId)).toBe(false);
  });

  it("scans the writable game-card directory and tracks every source for removal", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-installed-cards-"));
    temporaryDirectories.push(directory);
    const card = createBundledGridCard();
    const first = join(directory, "猎艳疆土.json");
    const second = join(directory, "猎艳疆土-副本.json");
    writeFileSync(first, JSON.stringify(card));
    writeFileSync(second, JSON.stringify(card));
    writeFileSync(join(directory, "损坏.json"), "{not-json");

    const scanned = scanGameCardDirectory(directory);
    const libraryId = gameCardLibraryKey(card);
    expect(scanned.cards.get(libraryId)?.packageSha256).toBe(card.packageSha256);
    expect([...scanned.sources.get(libraryId)]).toEqual(expect.arrayContaining([first, second]));
    expect(scanned.errors).toEqual([{ fileName: "损坏.json", message: "游戏卡 JSON 内容无效" }]);

    expect(removeGameCardDirectoryFiles(directory, scanned.sources.get(libraryId))).toHaveLength(2);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("uses one strict validator for dialog, drop, and directory imports", () => {
    const directory = mkdtempSync(join(tmpdir(), "fyow-card-validator-"));
    temporaryDirectories.push(directory);
    const valid = join(directory, "valid.json");
    writeFileSync(valid, `\uFEFF${JSON.stringify(createBundledGridCard())}`);
    expect(readGameCardFile(valid).card.title).toBe("猎艳疆土");

    const wrongExtension = join(directory, "card.txt");
    writeFileSync(wrongExtension, "{}");
    expect(() => readGameCardFile(wrongExtension)).toThrow(/必须是 JSON/);
    expect(() => readGameCardFile("relative.json")).toThrow(/路径无效/);
    expect(() => readGameCardFile(valid, { maxBytes: 64 })).toThrow(/超过/);
    expect(() => removeGameCardDirectoryFiles(directory, [join(directory, "..", "outside.json")])).toThrow(/目录之外/);
  });

  it("normalizes the rotating aliases returned by the creation export endpoint", () => {
    const original = createBundledGridCard();
    const live = {
      app_name: `艳猎征途[${GRID_COMPANION_INSTANCE_ID}]`,
      abstract: original.companion.configuration.app.summary,
      intro: original.companion.configuration.app.description,
      prefix_txt: original.companion.configuration.pre_text,
      ppt: original.companion.configuration.pre_prompt,
      suffix_txt: original.companion.configuration.post_text,
      world_bk: original.companion.configuration.world_book,
      ref_id2: 0,
      locale: "zh-Hans"
    };
    const exported = validateGameCard(createExportedGameCard(original, live));
    expect(exported.companion.configuration.app.name).toBe(`艳猎征途[${GRID_COMPANION_INSTANCE_ID}]`);
    expect(exported.companion.configuration.app.summary).toContain("64×64");
    expect(exported.companion.configuration.app.description).toContain("[[FYOW-PROGRAM/1:");
    expect(exported.companion.configuration.world_book).toHaveLength(7);
  });

  it("updates the card-level binding after an author-signed migration", () => {
    const rebound = validateGameCard(rebindGameCard(createBundledGridCard(), "new-work-12345678", "https://staging.aiero.cc"));
    expect(rebound.companion.workId).toBe("new-work-12345678");
    expect(rebound.companion.installedUrl).toContain("/installed/new-work-12345678");
    expect(rebound.companion.configuration.app.id).toBe("new-work-12345678");
  });

  it("keeps same-card servers isolated in the local library", () => {
    const first = rebindGameCard(createBundledGridCard(), "first-work-12345678");
    const second = rebindGameCard(createBundledGridCard(), "second-work-12345678");
    const directory = mkdtempSync(join(tmpdir(), "fyow-multi-server-card-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "cards.json");
    saveGameCardLibrary(file, new Map([[gameCardLibraryKey(first), first], [gameCardLibraryKey(second), second]]));
    const loaded = loadGameCardLibrary(file, null);
    expect(loaded.size).toBe(2);
    expect(loaded.get(gameCardLibraryKey(first))?.companion.workId).toBe("first-work-12345678");
    expect(loaded.get(gameCardLibraryKey(second))?.companion.workId).toBe("second-work-12345678");
    expect(loaded.get(first.cardId)).toBeUndefined();
    expect(summarizeGameCard(first).libraryId).toBe(gameCardLibraryKey(first));
    expect(summarizeGameCard(second).libraryId).toBe(gameCardLibraryKey(second));
  });
});
