import type { DomainCandidate } from "./types";

declare const GM_xmlhttpRequest: undefined | ((options: {
  method: string;
  url: string;
  timeout?: number;
  onload: (response: { status: number; responseText: string; finalUrl?: string }) => void;
  onerror: () => void;
  ontimeout: () => void;
}) => void);

export const DIRECTORY_URLS = [
  "https://aifordum.github.io/",
  "https://aify.pages.dev/"
] as const;
export const FALLBACK_ORIGINS = [
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
] as const;
export const TRUSTED_ORIGINS = new Set<string>(FALLBACK_ORIGINS);

const RESERVED_TLDS = new Set(["example", "invalid", "localhost", "local", "test"]);

function normalizePublishedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase();
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length < 2 || RESERVED_TLDS.has(labels.at(-1) || "") || /^\d+(?:\.\d+){3}$/.test(hostname)) return null;
    return `https://${hostname}`;
  } catch { return null; }
}

export function parseDomainDirectory(html: string): DomainCandidate[] {
  const seen = new Set<string>();
  const result: DomainCandidate[] = [];
  const append = (value: string, label = "") => {
    try {
      const origin = normalizePublishedOrigin(value);
      if (!origin || seen.has(origin)) return;
      const url = new URL(origin);
      TRUSTED_ORIGINS.add(origin);
      seen.add(origin);
      result.push({ label: label.trim() || url.hostname, origin, status: "untested" });
    } catch { /* ignore invalid links */ }
  };

  for (const block of html.matchAll(/(?:const|let|var)\s+SITES\s*=\s*\[([\s\S]*?)\]/gi)) {
    for (const match of String(block[1] || "").matchAll(/["'](https?:\/\/[^"'\s]+)["']/gi)) {
      if (match[1]) append(match[1]);
    }
  }
  if (result.length) return result;

  for (const match of html.matchAll(/<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (match[1]) append(match[1], String(match[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  }
  return result;
}

export function mergeDomainDirectories(documents: string[]): DomainCandidate[] {
  const result: DomainCandidate[] = [];
  const seen = new Set<string>();
  for (const html of documents) {
    for (const candidate of parseDomainDirectory(html)) {
      if (seen.has(candidate.origin)) continue;
      seen.add(candidate.origin);
      result.push(candidate);
    }
  }
  return result;
}

declare global {
  interface Window {
    fengyueDesktop?: {
      fetchText(options: { url: string; method: string; timeout: number }): Promise<{ status: number; text: string; finalUrl: string }>;
      platform: string;
    };
  }
}

function request(url: string, method = "GET", timeout = 8000): Promise<{ status: number; text: string; finalUrl: string }> {
  if (window.fengyueDesktop) return window.fengyueDesktop.fetchText({ url, method, timeout });
  return new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method,
        url,
        timeout,
        onload: response => resolve({ status: response.status, text: response.responseText, finalUrl: response.finalUrl ?? url }),
        onerror: () => reject(new Error("网络请求失败")),
        ontimeout: () => reject(new Error("连接超时"))
      });
      return;
    }
    fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeout) })
      .then(async response => resolve({ status: response.status, text: await response.text(), finalUrl: response.url }))
      .catch(reject);
  });
}

export async function fetchDomains(): Promise<DomainCandidate[]> {
  const responses = await Promise.allSettled(DIRECTORY_URLS.map(url => request(url)));
  const documents = responses
    .filter((item): item is PromiseFulfilledResult<{ status: number; text: string; finalUrl: string }> => item.status === "fulfilled" && item.value.status >= 200 && item.value.status < 400)
    .map(item => item.value.text);
  const live = mergeDomainDirectories(documents);
  const result = documents.length === DIRECTORY_URLS.length ? live : mergeDomainDirectories([
    `const SITES=${JSON.stringify(live.map(item => item.origin))}`,
    `const SITES=${JSON.stringify(FALLBACK_ORIGINS)}`
  ]);
  return result.length ? result : FALLBACK_ORIGINS.map(origin => ({ label: new URL(origin).hostname, origin, status: "untested" }));
}

export async function testDomain(candidate: DomainCandidate): Promise<DomainCandidate> {
  const started = performance.now();
  try {
    const response = await request(`${candidate.origin}/zh/chats`, "GET", 9000);
    const latencyMs = Math.round(performance.now() - started);
    const online = response.status >= 200 && response.status < 500;
    return { ...candidate, latencyMs, status: online ? (latencyMs > 2500 ? "slow" : "online") : "offline" };
  } catch {
    return { ...candidate, status: "offline" };
  }
}

export async function testDomains(candidates: DomainCandidate[], onResult?: (value: DomainCandidate) => void): Promise<DomainCandidate[]> {
  const queue = [...candidates];
  const results: DomainCandidate[] = [];
  const worker = async () => {
    while (queue.length) {
      const candidate = queue.shift();
      if (!candidate) return;
      const value = await testDomain(candidate);
      results.push(value);
      onResult?.(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  return results.sort((a, b) => (a.status === "offline" ? 1 : 0) - (b.status === "offline" ? 1 : 0) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
}
