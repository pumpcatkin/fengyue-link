"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createBundledGridCard, validateGameCard } = require("../electron/online-world-card.cjs");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const root = path.resolve(__dirname, "..");
const card = validateGameCard(createBundledGridCard());
const output = path.resolve(argument("out") || path.join(root, "release", `fengyue-link-hunting-frontier-game-card-v${card.version}.fyow-card.json`));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(card, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
console.log(`游戏卡已导出：${output}`);
console.log(`编号：${card.cardId}`);
console.log(`版本：${card.version}`);
console.log(`程序摘要：${card.program.digest}`);
