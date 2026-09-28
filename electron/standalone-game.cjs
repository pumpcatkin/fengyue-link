"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJsonSync, readJsonWithBackupSync } = require("./runtime-utils.cjs");
const RUNTIME = /<meta\s+name=["']fyow-runtime["']\s+content=["']standalone\/1["']\s*\/?>/i;
function isStandalone(html) { return RUNTIME.test(String(html || "")); }
function validateSave(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("游戏存档必须是 JSON 对象");
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > 60000) throw new Error("游戏存档超过 60KB");
  return JSON.parse(text);
}
function savePath(base, accountId, card) {
  if (!base || !accountId || !card?.companion?.workId) throw new Error("存档身份尚未就绪");
  const key = crypto.createHash("sha256").update(JSON.stringify([card.companion.origin, accountId, card.companion.workId, card.gameId])).digest("hex");
  return path.join(path.dirname(base), "standalone-saves", `${key}.json`);
}
function readSave(file) {
  if (!fs.existsSync(file)) return null;
  return readJsonWithBackupSync(fs, file, value => value?.schema === "fyow.standalone-save/1").value?.data || null;
}
function writeSave(file, data) {
  const valid = validateSave(data);
  atomicWriteJsonSync(fs, file, { schema: "fyow.standalone-save/1", data: valid, updatedAt: Date.now() }, { pretty: true });
  return valid;
}
module.exports = { isStandalone, validateSave, savePath, readSave, writeSave };
