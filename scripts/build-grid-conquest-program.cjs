"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { builtInGridProgram } = require("../electron/online-world-card.cjs");

const root = path.resolve(__dirname, "..");
const outputDirectory = path.join(root, "release-cache", "online-world");
const packed = builtInGridProgram();

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "grid-conquest-description-envelope.txt"), packed.envelope, "utf8");
fs.writeFileSync(path.join(outputDirectory, "grid-conquest-program.json"), JSON.stringify({ gameId: packed.manifest.gameId, digest: packed.digest, compressedBytes: packed.compressedBytes, htmlBytes: packed.htmlBytes }, null, 2), "utf8");
console.log(`游戏程序包已生成：${packed.digest}（压缩 ${packed.compressedBytes} 字节，HTML ${packed.htmlBytes} 字节）`);
