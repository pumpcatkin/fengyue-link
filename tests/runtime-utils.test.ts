import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const runtime = require("../electron/runtime-utils.cjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "fengyue-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("runtime persistence guards", () => {
  it("filters exported session logs to a requested time window", () => {
    const cutoff = Date.parse("2026-09-22T12:15:00.000Z");
    const input = [
      { time: "2026-09-22T12:14:59.999Z", category: "online-world", detail: { event: "old" } },
      { time: "2026-09-22T12:15:00.000Z", category: "network", detail: { event: "boundary" } },
      { time: "2026-09-22T12:29:59.000Z", category: "online-world", detail: { event: "recent" } }
    ].map(item => JSON.stringify(item)).join("\n");
    const result = runtime.filterSessionLogTextSince(input, cutoff);
    expect(result).not.toContain('"event":"old"');
    expect(result).toContain('"event":"boundary"');
    expect(result).toContain('"event":"recent"');
  });

  it("atomically replaces JSON without leaving a temporary file", () => {
    const directory = temporaryDirectory();
    const file = join(directory, "state.json");
    runtime.atomicWriteJsonSync(require("node:fs"), file, { revision: 1 }, { pretty: true });
    runtime.atomicWriteJsonSync(require("node:fs"), file, { revision: 2 }, { pretty: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ revision: 2 });
    expect(require("node:fs").readdirSync(directory).sort()).toEqual(["state.json", "state.json.bak"]);
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toEqual({ revision: 1 });
  });

  it("recovers JSON from the last valid backup", () => {
    const directory = temporaryDirectory();
    const file = join(directory, "state.json");
    writeFileSync(file, "not-json");
    writeFileSync(`${file}.bak`, JSON.stringify({ revision: 7 }));
    expect(runtime.readJsonWithBackupSync(require("node:fs"), file)).toMatchObject({ value: { revision: 7 }, recovered: true });
    writeFileSync(file, JSON.stringify({ invalid: true }));
    expect(runtime.readJsonWithBackupSync(require("node:fs"), file, (value: any) => Number.isInteger(value?.revision))).toMatchObject({ value: { revision: 7 }, recovered: true });
  });

  it("redacts secrets, truncates large values, and survives circular objects", () => {
    const detail: any = { password: "secret", nested: { token: "token", text: "private", description: "x".repeat(3000) } };
    detail.self = detail;
    const safe = runtime.sanitizeLogDetail(detail);
    expect(safe.password).toBe("[已隐藏]");
    expect(safe.nested.token).toBe("[已隐藏]");
    expect(safe.nested.text).toBe("[已隐藏]");
    expect(safe.nested.description.length).toBeLessThan(2100);
    expect(safe.self).toBe("[循环引用]");
  });

  it("removes expired and over-budget session logs only", () => {
    const directory = temporaryDirectory();
    const now = Date.now();
    const old = join(directory, "old.jsonl");
    const newest = join(directory, "newest.jsonl");
    const second = join(directory, "second.jsonl");
    const unrelated = join(directory, "keep.txt");
    for (const file of [old, newest, second]) writeFileSync(file, "x".repeat(20));
    writeFileSync(unrelated, "keep");
    utimesSync(old, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(second, new Date(now - 2000), new Date(now - 2000));
    utimesSync(newest, new Date(now - 1000), new Date(now - 1000));
    const result = runtime.pruneSessionLogDirectory(require("node:fs"), directory, { now, maxAgeMs: 5000, maxFiles: 1, maxTotalBytes: 1000 });
    expect(result).toMatchObject({ removed: 2, retained: 1, retainedBytes: statSync(newest).size });
    expect(readFileSync(unrelated, "utf8")).toBe("keep");
  });
});
