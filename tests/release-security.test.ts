import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  OFFICIAL_RELEASE_PAGE,
  ReleaseSecurityGate,
  compareVersions,
  exactReleasePage,
  parseVersion,
  sha256File,
  sha256FileAsync,
  validateManifestForRelease,
  validateManifestForRuntime,
  validateReleaseMetadata,
  verifyManifestSignature
} = require("../electron/release-security.cjs");

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function releaseMetadata(overrides: Record<string, unknown> = {}) {
  const tag = "v0.12.0";
  return {
    id: 120,
    tag_name: tag,
    html_url: exactReleasePage(tag),
    draft: false,
    prerelease: false,
    published_at: "2026-09-08T00:00:00.000Z",
    assets: [
      {
        name: "release-manifest.json",
        state: "uploaded",
        size: 640,
        url: "https://api.github.com/repos/pumpcatkin/fengyue-link/releases/assets/1"
      },
      {
        name: "release-manifest.sig",
        state: "uploaded",
        size: 89,
        url: "https://api.github.com/repos/pumpcatkin/fengyue-link/releases/assets/2"
      },
      {
        name: "fengyue-link-0.12.0-setup.exe",
        state: "uploaded",
        size: 456,
        url: "https://api.github.com/repos/pumpcatkin/fengyue-link/releases/assets/3"
      }
    ],
    ...overrides
  };
}

function signedManifestShape() {
  const tag = "v0.12.0";
  return {
    schemaVersion: 1,
    product: "fengyue-link",
    appId: "cc.aiero.fengyue.link",
    version: "0.12.0",
    tag,
    officialReleasePage: OFFICIAL_RELEASE_PAGE,
    releasePage: exactReleasePage(tag),
    publishedAt: "2026-09-08T00:00:00.000Z",
    files: {
      appAsar: { path: "resources/app.asar", size: 123, sha256: "a".repeat(64) },
      executable: { name: "风月联机工具.exe", size: 321, sha256: "c".repeat(64) },
      installer: { name: "fengyue-link-0.12.0-setup.exe", size: 456, sha256: "b".repeat(64) }
    }
  };
}

describe("official release security", () => {
  it("parses and compares release versions without lexical ordering mistakes", () => {
    expect(parseVersion("v0.12.0")?.raw).toBe("0.12.0");
    expect(compareVersions("0.12.0", "0.11.9")).toBe(1);
    expect(compareVersions("0.12.0", "0.12.0")).toBe(0);
    expect(compareVersions("0.12.0-test.1", "0.12.0")).toBe(-1);
    expect(() => compareVersions("latest", "0.12.0")).toThrow(/版本号格式无效/);
  });

  it("verifies Ed25519 signatures over the exact manifest bytes", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const manifest = Buffer.from(JSON.stringify(signedManifestShape()), "utf8");
    const signature = crypto.sign(null, manifest, privateKey).toString("base64");
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    expect(verifyManifestSignature(manifest, signature, publicPem)).toBe(true);
    expect(() => verifyManifestSignature(Buffer.concat([manifest, Buffer.from(" ")]), signature, publicPem)).toThrow(/数字签名/);
  });

  it("accepts only the exact official repository release and required assets", () => {
    const release = validateReleaseMetadata(releaseMetadata());
    expect(release.version).toBe("0.12.0");
    expect(release.manifestAsset.name).toBe("release-manifest.json");
    expect(release.installerAsset.name).toBe("fengyue-link-0.12.0-setup.exe");
    expect(() => validateReleaseMetadata(releaseMetadata({ html_url: "https://github.com/example/fake/releases/tag/v0.12.0" }))).toThrow(/唯一官方仓库/);
    expect(() => validateReleaseMetadata(releaseMetadata({ assets: [] }))).toThrow(/缺少唯一/);
  });

  it("binds the signed manifest to the product, tag, app.asar and installer", () => {
    const release = validateReleaseMetadata(releaseMetadata());
    const manifest = validateManifestForRelease(signedManifestShape(), release);
    expect(manifest.files.appAsar.sha256).toBe("a".repeat(64));
    expect(manifest.files.executable.sha256).toBe("c".repeat(64));
    expect(manifest.files.installer.name).toBe("fengyue-link-0.12.0-setup.exe");
    expect(() => validateManifestForRelease({ ...signedManifestShape(), appId: "fake.app" }, release)).toThrow(/产品身份/);
    expect(() => validateManifestForRelease({ ...signedManifestShape(), version: "0.12.1" }, release)).toThrow(/版本/);
  });

  it("calculates installed artifact SHA-256 without blocking the Electron event loop", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fengyue-release-security-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "app.asar");
    writeFileSync(file, "signed app fixture", "utf8");
    const expected = crypto.createHash("sha256").update("signed app fixture").digest("hex");
    expect(sha256File(file)).toBe(expected);
    expect(await sha256FileAsync(file)).toBe(expected);
  });

  it("does not start another request after the shared verification deadline", async () => {
    let requested = false;
    const gate = new ReleaseSecurityGate({
      net: { fetch: async () => { requested = true; throw new Error("unexpected request"); } },
      appVersion: "0.12.1",
      isPackaged: false,
      resourcesPath: "",
      executablePath: "",
      userDataPath: ""
    });
    await expect(gate.fetch("https://api.github.com/test", {}, 1024, "测试请求", Date.now() - 1))
      .rejects.toMatchObject({ code: "network-timeout" });
    expect(requested).toBe(false);
  });

  it("retries transient GitHub transport errors within the startup deadline", async () => {
    let attempts = 0;
    const gate = new ReleaseSecurityGate({
      net: {
        fetch: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("proxy reconnecting");
          return {
            ok: true,
            status: 200,
            headers: { get: () => "5" },
            arrayBuffer: async () => new TextEncoder().encode("ready").buffer
          };
        }
      },
      appVersion: "0.12.1",
      isPackaged: false,
      resourcesPath: "",
      executablePath: "",
      userDataPath: ""
    });
    const bytes = await gate.fetch("https://api.github.com/test", {}, 1024, "测试请求", Date.now() + 5000);
    expect(Buffer.from(bytes).toString("utf8")).toBe("ready");
    expect(attempts).toBe(3);
  });

  it("limits startup integrity validation to the two token-relevant runtime files", () => {
    const runtimeManifest = validateManifestForRuntime(signedManifestShape());
    expect(runtimeManifest.files).toEqual({
      appAsar: expect.objectContaining({ path: "resources/app.asar" }),
      executable: expect.objectContaining({ name: "风月联机工具.exe" })
    });
    const withoutInstaller = signedManifestShape();
    delete (withoutInstaller.files as { installer?: unknown }).installer;
    expect(validateManifestForRuntime(withoutInstaller).version).toBe("0.12.0");
  });

  it("performs a fresh signed-manifest request on every packaged startup", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fengyue-release-attempt-"));
    temporaryDirectories.push(directory);
    const options = {
      appVersion: "0.12.3",
      isPackaged: true,
      resourcesPath: directory,
      executablePath: path.join(directory, "风月联机工具.exe"),
      userDataPath: directory
    };
    let requested = false;
    const reader = new ReleaseSecurityGate({
      ...options,
      net: { fetch: async () => { requested = true; throw new Error("expected online verification"); } }
    });
    const state = await reader.initialize();
    expect(state).toMatchObject({ status: "unavailable", verified: false, errorCode: "network-error" });
    expect(requested).toBe(true);
  });
});
