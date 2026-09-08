import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { userscriptMetadata } from "../vite.config";

describe("release version consistency", () => {
  it("uses the package version in userscript metadata", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(userscriptMetadata).toContain(`// @version      ${packageJson.version}`);
  });
});
