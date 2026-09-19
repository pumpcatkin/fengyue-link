"use strict";

const OFFICIAL_DOMAIN_DIRECTORY_URLS = Object.freeze([
  "https://aifordum.github.io/",
  "https://aify.pages.dev/"
]);

const FALLBACK_PLATFORM_ORIGINS = Object.freeze([
  "https://acepro.store",
  "https://acquainte.xyz",
  "https://acquant.xyz",
  "https://affectional.xyz",
  "https://aiwhatis.xyz",
  "https://ai-xan.xyz",
  "https://aquantancee.xyz",
  "https://aigirlfriend.baby",
  "https://aquante.xyz",
  "https://aisearches.xyz"
]);

const RESERVED_TLDS = new Set(["example", "invalid", "localhost", "local", "test"]);

function normalizePublishedOrigin(value) {
  try {
    const raw = String(value || "").trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = String(url.hostname || "").toLowerCase();
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length < 2 || RESERVED_TLDS.has(labels.at(-1)) || /^\d+(?:\.\d+){3}$/.test(hostname)) return null;
    return `https://${hostname}`;
  } catch {
    return null;
  }
}

function parsePublishedOrigins(html) {
  const result = [];
  const seen = new Set();
  const source = String(html || "");
  for (const block of source.matchAll(/(?:const|let|var)\s+SITES\s*=\s*\[([\s\S]*?)\]/gi)) {
    for (const match of block[1].matchAll(/["'](https?:\/\/[^"'\s]+)["']/gi)) {
      const origin = normalizePublishedOrigin(match[1]);
      if (!origin || seen.has(origin)) continue;
      seen.add(origin);
      result.push(origin);
    }
  }
  return result;
}

function mergePublishedOrigins(documents) {
  const result = [];
  const seen = new Set();
  for (const html of Array.isArray(documents) ? documents : []) {
    for (const origin of parsePublishedOrigins(html)) {
      if (seen.has(origin)) continue;
      seen.add(origin);
      result.push(origin);
    }
  }
  return result;
}

module.exports = {
  OFFICIAL_DOMAIN_DIRECTORY_URLS,
  FALLBACK_PLATFORM_ORIGINS,
  normalizePublishedOrigin,
  parsePublishedOrigins,
  mergePublishedOrigins
};
