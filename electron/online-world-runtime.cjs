"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { canonicalJson } = require("./online-world-protocol.cjs");

const PROGRAM_FORMAT = "fyow.program/1";
const PROGRAM_PREFIX = "[[FYOW-PROGRAM/1:";
const PROGRAM_SUFFIX = "]]";
const MAX_COMPRESSED_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const PROGRAM_NONCE = "fyow-game-v1";
const SANDBOX_CSP = `default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'nonce-${PROGRAM_NONCE}'; script-src 'nonce-${PROGRAM_NONCE}'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function packProgram({ gameId, title, html, apiVersion = 1 }) {
  const source = String(html || "");
  if (!source.trim()) throw new Error("游戏程序缺少 HTML 入口");
  if (Buffer.byteLength(source, "utf8") > MAX_HTML_BYTES) throw new Error("游戏程序解压后超过 1 MiB");
  const manifest = { format: PROGRAM_FORMAT, gameId: String(gameId), title: String(title || gameId).slice(0, 80), apiVersion: Number(apiVersion), html: source };
  const compressed = zlib.gzipSync(Buffer.from(canonicalJson(manifest), "utf8"), { level: 9, mtime: 0 });
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new Error("游戏程序压缩后超过 256 KiB");
  const digest = sha256(compressed);
  return { envelope: `${PROGRAM_PREFIX}${digest}:${compressed.toString("base64url")}${PROGRAM_SUFFIX}`, digest, compressedBytes: compressed.length, htmlBytes: Buffer.byteLength(source, "utf8"), manifest };
}

function injectSandboxCsp(html) {
  let source = String(html || "");
  if (/<script\b[^>]*\bsrc\s*=/i.test(source)) throw new Error("游戏程序必须把 JavaScript 内联，不能引用外部脚本");
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(source)) throw new Error("游戏程序必须把 CSS 内联，不能引用外部样式表");
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(source)) throw new Error("游戏程序不能使用页面自动跳转");
  if (/@import\s+(?:url\s*\()?\s*["']?(?:https?:|\/\/|file:)/i.test(source)) throw new Error("游戏程序样式不能导入外部资源");
  source = source.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, "");
  source = source.replace(/<(script|style)\b(?![^>]*\bnonce=)/gi, `<$1 nonce="${PROGRAM_NONCE}"`);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;
  if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, match => `${match}${meta}`);
  return `<!doctype html><html><head>${meta}<meta charset="UTF-8"></head><body>${source}</body></html>`;
}

function composeSingleFileProgram(html, css, javascript) {
  const script = String(javascript || "").replace(/<\/script/gi, "<\\/script");
  return String(html || "")
    .replace(/\s*<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/i, "")
    .replace(/\s*<link\b[^>]*href=["']styles\.css["'][^>]*>/i, `\n    <style>${String(css || "")}</style>`)
    .replace(/\s*<script\b[^>]*src=["']game\.js["'][^>]*><\/script>/i, `\n    <script>${script}</script>`);
}

function parseProgram(description, expectedGameId = null) {
  const text = String(description || "");
  const match = text.match(/\[\[FYOW-PROGRAM\/1:([a-f0-9]{64}):([A-Za-z0-9_-]+)\]\]/i);
  if (!match) return null;
  const compressed = Buffer.from(match[2], "base64url");
  if (!compressed.length || compressed.length > MAX_COMPRESSED_BYTES) throw new Error("作品详细介绍中的程序包大小无效");
  const digest = sha256(compressed);
  if (digest !== match[1].toLowerCase()) throw new Error("作品详细介绍中的程序包摘要不一致");
  let manifest;
  try {
    manifest = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: MAX_HTML_BYTES + 64 * 1024 }).toString("utf8"));
  } catch (error) {
    throw new Error(`作品详细介绍中的程序包损坏：${error?.message || error}`);
  }
  if (manifest?.format !== PROGRAM_FORMAT || Number(manifest?.apiVersion) !== 1) throw new Error("游戏程序包格式或宿主 API 版本不受支持");
  if (!manifest.gameId || (expectedGameId && manifest.gameId !== expectedGameId)) throw new Error("游戏程序包与当前游戏类型不匹配");
  if (typeof manifest.html !== "string" || !manifest.html.trim() || Buffer.byteLength(manifest.html, "utf8") > MAX_HTML_BYTES) throw new Error("游戏程序包入口无效");
  return { manifest: { ...manifest, html: undefined }, digest, html: injectSandboxCsp(manifest.html), compressedBytes: compressed.length, source: "work-description" };
}

module.exports = { PROGRAM_FORMAT, PROGRAM_PREFIX, PROGRAM_SUFFIX, PROGRAM_NONCE, MAX_COMPRESSED_BYTES, MAX_HTML_BYTES, SANDBOX_CSP, packProgram, parseProgram, injectSandboxCsp, composeSingleFileProgram };
