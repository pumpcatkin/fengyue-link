import { describe, expect, it } from "vitest";
import { DIRECTORY_URLS, FALLBACK_ORIGINS, mergeDomainDirectories, parseDomainDirectory } from "../src/domain-service";

describe("domain directory parsing", () => {
  it("reads the live directory's SITES array without executing its script", () => {
    const html = `<script>
      const SITES = [
        "https://acepro.store",
        "http://aisearches.xyz",
        "https://acepro.store/path",
        "https://untrusted.example",
        "ftp://ignored.example"
      ];
    </script>`;

    expect(parseDomainDirectory(html)).toEqual([
      { label: "acepro.store", origin: "https://acepro.store", status: "untested" },
      { label: "aisearches.xyz", origin: "https://aisearches.xyz", status: "untested" }
    ]);
  });

  it("merges both official directories, upgrades http entries, and removes duplicates", () => {
    expect(DIRECTORY_URLS).toEqual(["https://aifordum.github.io/", "https://aify.pages.dev/"]);
    expect(FALLBACK_ORIGINS).toHaveLength(10);
    expect(mergeDomainDirectories([
      '<script>const SITES=["https://acepro.store","http://aigirlfriend.baby"]</script>',
      '<script>const SITES=["https://acepro.store/path","http://aisearches.xyz"]</script>'
    ])).toEqual([
      { label: "acepro.store", origin: "https://acepro.store", status: "untested" },
      { label: "aigirlfriend.baby", origin: "https://aigirlfriend.baby", status: "untested" },
      { label: "aisearches.xyz", origin: "https://aisearches.xyz", status: "untested" }
    ]);
  });
});
