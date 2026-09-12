"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { packProgram, composeSingleFileProgram } = require("../electron/online-world-runtime.cjs");
const { GRID_GAME_ID } = require("../electron/grid-world-game.cjs");

const root = path.resolve(__dirname, "..");
const sourceDirectory = path.join(root, "electron", "desktop", "online-world", "grid-conquest");
const outputDirectory = path.join(root, "release-cache", "online-world");
const originalHtml = fs.readFileSync(path.join(sourceDirectory, "index.html"), "utf8");
const css = fs.readFileSync(path.join(sourceDirectory, "styles.css"), "utf8");
const javascript = fs.readFileSync(path.join(sourceDirectory, "game.js"), "utf8");
const html = composeSingleFileProgram(originalHtml, css, javascript);
const packed = packProgram({ gameId: GRID_GAME_ID, title: "烽火慧眼", html });

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "grid-conquest-description-envelope.txt"), packed.envelope, "utf8");
fs.writeFileSync(path.join(outputDirectory, "grid-conquest-program.json"), JSON.stringify({ gameId: GRID_GAME_ID, digest: packed.digest, compressedBytes: packed.compressedBytes, htmlBytes: packed.htmlBytes }, null, 2), "utf8");
console.log(`游戏程序包已生成：${packed.digest}（压缩 ${packed.compressedBytes} 字节，HTML ${packed.htmlBytes} 字节）`);
