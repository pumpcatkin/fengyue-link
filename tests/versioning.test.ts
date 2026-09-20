import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { userscriptMetadata } from "../vite.config";

describe("release version consistency", () => {
  it("uses the package version in userscript metadata", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(userscriptMetadata).toContain(`// @version      ${packageJson.version}`);
  });

  it("packages the GitHub updater metadata required by installed builds", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const updateConfig = readFileSync(new URL("../build/app-update.yml", import.meta.url), "utf8");
    expect(packageJson.build.extraResources).toContainEqual({
      from: "build/app-update.yml",
      to: "app-update.yml"
    });
    expect(updateConfig).toContain("provider: github");
    expect(updateConfig).toContain("owner: pumpcatkin");
    expect(updateConfig).toContain("repo: fengyue-link");
    expect(updateConfig).toContain("updaterCacheDirName: fengyue-link-updater");
  });
});
