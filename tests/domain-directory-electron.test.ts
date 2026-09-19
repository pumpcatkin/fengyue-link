import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const directory = require("../electron/domain-directory.cjs") as {
  OFFICIAL_DOMAIN_DIRECTORY_URLS: string[];
  FALLBACK_PLATFORM_ORIGINS: string[];
  normalizePublishedOrigin(value: string): string | null;
  mergePublishedOrigins(documents: string[]): string[];
};

describe("desktop official domain directories", () => {
  it("combines the two publishers into secure, unique origins", () => {
    expect(directory.OFFICIAL_DOMAIN_DIRECTORY_URLS).toEqual([
      "https://aifordum.github.io/",
      "https://aify.pages.dev/"
    ]);
    expect(directory.mergePublishedOrigins([
      '<script>const SITES=["https://acepro.store","http://aigirlfriend.baby"]</script>',
      '<script>const SITES=["https://acepro.store/path","http://aisearches.xyz","https://ignored.example"]</script>'
    ])).toEqual([
      "https://acepro.store",
      "https://aigirlfriend.baby",
      "https://aisearches.xyz"
    ]);
    expect(directory.FALLBACK_PLATFORM_ORIGINS).toContain("https://aigirlfriend.baby");
    expect(directory.FALLBACK_PLATFORM_ORIGINS).toContain("https://aisearches.xyz");
    expect(directory.normalizePublishedOrigin("acepro.store/zh/signin")).toBe("https://acepro.store");
    expect(directory.normalizePublishedOrigin("http://aigirlfriend.baby/path")).toBe("https://aigirlfriend.baby");
  });
});
