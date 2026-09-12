import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { packProgram, parseProgram, SANDBOX_CSP } = require("../electron/online-world-runtime.cjs");

describe("online world program runtime", () => {
  it("round-trips a program embedded inside a work description", () => {
    const html = "<!doctype html><html><head></head><body><script>parent.postMessage({source:'game'},'*')</script></body></html>";
    const packed = packProgram({ gameId: "game.example", title: "Example", html });
    const parsed = parseProgram(`<p>介绍</p>${packed.envelope}<p>结尾</p>`, "game.example");
    expect(parsed.digest).toBe(packed.digest);
    expect(parsed.html).toContain(SANDBOX_CSP);
    expect(parsed.html).toContain("parent.postMessage");
    expect(parsed.html).toContain('script nonce="fyow-game-v1"');
  });

  it("rejects a changed digest and a mismatched game id", () => {
    const packed = packProgram({ gameId: "game.a", title: "A", html: "<p>A</p>" });
    const changedDigest = `${packed.digest[0] === "0" ? "1" : "0"}${packed.digest.slice(1)}`;
    expect(() => parseProgram(packed.envelope.replace(packed.digest, changedDigest), "game.a")).toThrow();
    expect(() => parseProgram(packed.envelope, "game.b")).toThrow(/游戏类型/);
  });

  it("removes a downloaded CSP and installs the no-network sandbox policy", () => {
    const packed = packProgram({ gameId: "game.a", title: "A", html: "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"connect-src *\"></head><body>A</body></html>" });
    const parsed = parseProgram(packed.envelope, "game.a");
    expect(parsed.html).not.toContain("connect-src *");
    expect(parsed.html).toContain("connect-src 'none'");
    expect(parsed.html).toContain("worker-src 'none'");
  });

  it("rejects executable external subresources before adding the runtime nonce", () => {
    const script = packProgram({ gameId: "game.a", title: "A", html: '<html><body><script src="https://example.test/game.js"></script></body></html>' });
    const style = packProgram({ gameId: "game.a", title: "A", html: '<html><head><link rel="stylesheet" href="https://example.test/game.css"></head></html>' });
    expect(() => parseProgram(script.envelope, "game.a")).toThrow(/外部脚本/);
    expect(() => parseProgram(style.envelope, "game.a")).toThrow(/外部样式表/);
  });
});
