"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const manifest = [
  ["runtime-contract", "electron/game-harness.cjs", "implemented"],
  ["bridge-starter", "electron/standalone-starter.html", "implemented"],
  ["grid-tasks", "electron/online-world-card.cjs", "implemented"],
  ["grid-rules", "electron/grid-world-game.cjs", "implemented"],
  ["grid-protocol", "electron/online-world-protocol.cjs", "implemented"],
  ["generic-model-runtime", "docs/通用游戏模型任务接口-2026-10-02.md", "implemented"],
  ["game-card-manual", "docs/游戏卡制作经验与接口手册.md", "reference"],
  ["pagination-lessons", "docs/cloud-pagination-diagnosis-0.15.22.md", "historical"],
  ["publication-lessons", "docs/pending-publication-diagnosis-0.15.23.md", "historical"],
  ["generic-sdk-design", "docs/游戏卡接口规范化与创作助手方案.md", "design-only"]
];
function records() {
  const bundle = path.join(__dirname, "knowledge", "index.json");
  if (fs.existsSync(bundle)) return JSON.parse(fs.readFileSync(bundle, "utf8"));
  return manifest.map(([id, file, status]) => {
    const content = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    return { id, file, status, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  });
}
function readKnowledge(id, offset = 0, limit = 12000) {
  const record = records().find(item => item.id === id);
  if (!record) throw new Error("知识条目不在公开清单中");
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  return { ...record, content: record.content.slice(start, start + Math.min(24000, Math.max(1, Number(limit) || 12000))), offset: start, total: record.content.length };
}
function searchKnowledge(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw new Error("请提供明确的知识检索词");
  return records().flatMap(({ content, ...record }) => {
    const at = content.toLowerCase().indexOf(needle);
    return at < 0 ? [] : [{ ...record, offset: Math.max(0, at - 200), excerpt: content.slice(Math.max(0, at - 200), at + 1200) }];
  }).slice(0, 8);
}
module.exports = { manifest, records, readKnowledge, searchKnowledge };
