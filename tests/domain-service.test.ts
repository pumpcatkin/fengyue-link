import { describe, expect, it } from "vitest";
import { parseDomainDirectory } from "../src/domain-service";

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
      { label: "acepro.store", origin: "https://acepro.store", status: "untested" }
    ]);
  });
});
