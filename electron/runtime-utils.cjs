"use strict";

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|verifier)|^(?:raw|input|output|query|answer|content|text|basicInfo|appearance|info)$/i;

function atomicWriteFileSync(fs, file, value, options = {}) {
  if (typeof fs.mkdirSync === "function") fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  if (typeof fs.renameSync !== "function" || typeof fs.rmSync !== "function") {
    fs.writeFileSync(file, value, options);
    return;
  }
  const temporary = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, value, options);
    if (fs.existsSync(file) && typeof fs.copyFileSync === "function") fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function readJsonWithBackupSync(fs, file, validator = () => true) {
  const errors = [];
  for (const candidate of [file, `${file}.bak`]) {
    if (typeof fs.existsSync === "function" && !fs.existsSync(candidate)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (!validator(value)) throw new Error("JSON 数据结构无效");
      return { value, source: candidate, recovered: candidate !== file };
    } catch (error) { errors.push(error); }
  }
  return { value: null, source: null, recovered: false, error: errors.at(-1) || null };
}

function atomicWriteJsonSync(fs, file, value, { pretty = false, mode = 0o600 } = {}) {
  atomicWriteFileSync(fs, file, JSON.stringify(value, null, pretty ? 2 : 0), { encoding: "utf8", mode });
}

function sanitizeLogDetail(value, options = {}, depth = 0, seen = new WeakSet()) {
  const maxDepth = Math.max(1, Number(options.maxDepth) || 5);
  const maxArrayLength = Math.max(1, Number(options.maxArrayLength) || 40);
  const maxObjectKeys = Math.max(1, Number(options.maxObjectKeys) || 60);
  const maxStringLength = Math.max(64, Number(options.maxStringLength) || 2000);
  if (typeof value === "string") {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…[截断 ${value.length - maxStringLength} 字符]` : value;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Error) return { name: value.name, message: sanitizeLogDetail(value.message, options, depth + 1, seen) };
  if (depth >= maxDepth) return "[达到日志深度上限]";
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, maxArrayLength).map(item => sanitizeLogDetail(item, options, depth + 1, seen));
    if (value.length > maxArrayLength) result.push(`[另有 ${value.length - maxArrayLength} 项]`);
    return result;
  }
  const result = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, maxObjectKeys)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[已隐藏]" : sanitizeLogDetail(item, options, depth + 1, seen);
  }
  if (entries.length > maxObjectKeys) result.__truncatedKeys = entries.length - maxObjectKeys;
  return result;
}

function pruneSessionLogDirectory(fs, directory, options = {}) {
  const now = Number(options.now) || Date.now();
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || 7 * 24 * 60 * 60 * 1000);
  const maxFiles = Math.max(1, Number(options.maxFiles) || 20);
  const maxTotalBytes = Math.max(1024, Number(options.maxTotalBytes) || 20 * 1024 * 1024);
  if (!fs.existsSync(directory)) return { removed: 0, retained: 0, retainedBytes: 0 };

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = require("node:path").join(directory, entry.name);
    try {
      const stat = fs.statSync(file);
      files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let retained = 0;
  let retainedBytes = 0;
  let removed = 0;
  for (const item of files) {
    const expired = now - item.mtimeMs > maxAgeMs;
    const overBudget = retained >= maxFiles || retainedBytes + item.size > maxTotalBytes;
    if (expired || overBudget) {
      try { fs.rmSync(item.file, { force: true }); removed += 1; } catch {}
      continue;
    }
    retained += 1;
    retainedBytes += item.size;
  }
  return { removed, retained, retainedBytes };
}

function filterSessionLogTextSince(text, since) {
  const cutoff = Number(since);
  if (!Number.isFinite(cutoff)) return "";
  const retained = String(text || "").split(/\r?\n/).filter(Boolean).filter(line => {
    try {
      const timestamp = Date.parse(String(JSON.parse(line)?.time || ""));
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    } catch {
      return false;
    }
  });
  return retained.length ? `${retained.join("\n")}\n` : "";
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync, readJsonWithBackupSync, sanitizeLogDetail, pruneSessionLogDirectory, filterSessionLogTextSince };
