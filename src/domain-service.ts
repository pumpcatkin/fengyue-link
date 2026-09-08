import type { DomainCandidate } from "./types";

declare const GM_xmlhttpRequest: undefined | ((options: {
  method: string;
  url: string;
  timeout?: number;
  onload: (response: { status: number; responseText: string; finalUrl?: string }) => void;
  onerror: () => void;
  ontimeout: () => void;
}) => void);

const DIRECTORY_URL = "https://aify.pages.dev/";
export const TRUSTED_ORIGINS = new Set([
  "https://acepro.store",
  "https://acquainte.xyz",
  "https://acquant.xyz",
  "https://affectional.xyz",
  "https://aiwhatis.xyz",
  "https://ai-xan.xyz",
  "https://aquantancee.xyz",
  "https://aquante.xyz"
]);

export function parseDomainDirectory(html: string): DomainCandidate[] {
  const seen = new Set<string>();
  const result: DomainCandidate[] = [];
  const append = (value: string, label = "") => {
    try {
      const url = new URL(value, DIRECTORY_URL);
      if (url.protocol !== "https:" || !TRUSTED_ORIGINS.has(url.origin) || seen.has(url.origin)) return;
      seen.add(url.origin);
      result.push({ label: label.trim() || url.hostname, origin: url.origin, status: "untested" });
    } catch { /* ignore invalid links */ }
  };

  const sites = html.match(/const\s+SITES\s*=\s*\[([\s\S]*?)\]/i)?.[1] || "";
  for (const match of sites.matchAll(/["'](https:\/\/[^"'/?#]+)["']/gi)) {
    if (match[1]) append(match[1]);
  }
  if (result.length) return result;

  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')) append(anchor.href, anchor.textContent || "");
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
  const response = await request(DIRECTORY_URL);
  const result = parseDomainDirectory(response.text);
  if (!result.length) throw new Error("域名目录中没有找到可用节点");
  return result;
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
