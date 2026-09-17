import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
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
  validateGameCard,
  rebindGameCard,
  loadGameCardLibrary,
  saveGameCardLibrary
} = require("../electron/online-world-card.cjs");
const { parseProgram } = require("../electron/online-world-runtime.cjs");

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
    expect(card.version).toBe(19);
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
    expect(card.companion.configuration.world_book).toHaveLength(5);
    expect(card.companion.configuration.world_book.map((entry: any) => entry.key)).toEqual([
      "_or_[[FYOW:TASK:general.generate:v1]]",
      "_or_[[FYOW:TASK:player.profile-context:v1]]",
      "_or_[[FYOW:TASK:general.dialogue:v1]]",
      "_or_[[FYOW:TASK:general.captive-dialogue:v1]]",
      "_or_[[FYOW:TASK:general.memory.update:v1]]"
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
    expect(exported.companion.configuration.world_book).toHaveLength(5);
  });

  it("updates the card-level binding after an author-signed migration", () => {
    const rebound = validateGameCard(rebindGameCard(createBundledGridCard(), "new-work-12345678", "https://staging.aiero.cc"));
    expect(rebound.companion.workId).toBe("new-work-12345678");
    expect(rebound.companion.installedUrl).toContain("/installed/new-work-12345678");
    expect(rebound.companion.configuration.app.id).toBe("new-work-12345678");
  });
});
