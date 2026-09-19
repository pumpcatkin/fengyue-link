import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { AUTHOR_LINKS, configuredAuthorUrl, publicAuthorInfo } = require("../electron/author-info.cjs");

describe("author information", () => {
  it("publishes the author, profile and fixed official GitHub download page", () => {
    const info = publicAuthorInfo();
    expect(info.name).toBe("八爪毛米");
    expect(info.links.homepage).toEqual({
      key: "homepage",
      label: "作者主页",
      configured: true,
      url: "https://staging.aiero.cc/zh/profile/39404f0e-7678-45a1-86c6-9a21116bacbd"
    });
    expect(info.links.github).toEqual({
      key: "github",
      label: "GitHub 下载页",
      configured: true,
      url: "https://github.com/pumpcatkin/fengyue-link/releases/latest"
    });
    expect(configuredAuthorUrl("homepage")).toBe("https://staging.aiero.cc/zh/profile/39404f0e-7678-45a1-86c6-9a21116bacbd");
    expect(configuredAuthorUrl("github")).toBe("https://github.com/pumpcatkin/fengyue-link/releases/latest");
  });

  it("keeps links awaiting author input visibly unavailable", () => {
    const info = publicAuthorInfo();
    for (const key of ["releasePost", "feedbackPost"] as const) {
      expect(AUTHOR_LINKS[key]).toBe("");
      expect(info.links[key].configured).toBe(false);
      expect(info.links[key].url).toBeNull();
      expect(() => configuredAuthorUrl(key)).toThrow("待作者补充");
    }
  });

  it("accepts only reviewed author-link keys", () => {
    expect(() => configuredAuthorUrl("https://example.com/unsafe")).toThrow("未知的作者信息链接");
  });

  it("keeps the release-post draft in the requested three-part structure", () => {
    const draft = readFileSync(new URL("../docs/release-post-draft.md", import.meta.url), "utf8");
    expect(draft.match(/^# .+$/gm)).toEqual(["# 前言-必须阅读", "# 介绍", "# 测试者谢鸣"]);
    expect(draft).toContain("[南瓜联机工具讨论贴](FEEDBACK_POST_URL)");
    expect(draft).toContain("[前往唯一官方 GitHub 发布页](https://github.com/pumpcatkin/fengyue-link/releases/latest)");
    expect(draft).toContain("作者：八爪毛米");
  });
});
