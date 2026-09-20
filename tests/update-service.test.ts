import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { OfficialUpdateService } = require("../electron/update-service.cjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function updater() {
  const value: any = new EventEmitter();
  value.checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: false,
    updateInfo: { version: "0.12.6" }
  }));
  value.downloadUpdate = vi.fn(async () => []);
  value.quitAndInstall = vi.fn();
  value.setFeedURL = vi.fn();
  return value;
}

function updateFixture(canInstallNow = () => true) {
  const directory = mkdtempSync(path.join(tmpdir(), "fengyue-update-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "fengyue-link-0.12.7-setup.exe");
  const bytes = Buffer.from("signed installer fixture", "utf8");
  writeFileSync(file, bytes);
  const update = {
    version: "0.12.7",
    tag: "v0.12.7",
    releasePage: "https://github.com/pumpcatkin/fengyue-link/releases/tag/v0.12.7",
    installer: {
      name: path.basename(file),
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    }
  };
  const fakeUpdater = updater();
  const releaseSecurity = { fetchSignedUpdate: vi.fn(async () => update) };
  const service = new OfficialUpdateService({
    updater: fakeUpdater,
    releaseSecurity,
    isPackaged: true,
    currentVersion: "0.12.6",
    feedOptions: { provider: "github", owner: "pumpcatkin", repo: "fengyue-link" },
    canInstallNow,
    installDelayMs: 0
  });
  return { service, fakeUpdater, releaseSecurity, file, update };
}

describe("official installer optional update", () => {
  it("checks GitHub updates only for a packaged application", async () => {
    const fakeUpdater = updater();
    const service = new OfficialUpdateService({
      updater: fakeUpdater,
      releaseSecurity: {},
      isPackaged: false,
      currentVersion: "0.12.6"
    });
    await service.start();
    expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.state().status).toBe("development");
  });

  it("checks for a new version without downloading or enabling installation", async () => {
    const { service, fakeUpdater } = updateFixture();
    await service.start();
    expect(fakeUpdater.autoDownload).toBe(false);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
    expect(fakeUpdater.allowPrerelease).toBe(false);
    expect(fakeUpdater.setFeedURL).toHaveBeenCalledWith({ provider: "github", owner: "pumpcatkin", repo: "fengyue-link" });
    expect(fakeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(fakeUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("shows the requested wording while GitHub latest is being fetched", async () => {
    const { service, fakeUpdater } = updateFixture();
    let finishCheck!: (result: unknown) => void;
    fakeUpdater.checkForUpdates.mockImplementation(() => new Promise(resolve => {
      finishCheck = resolve;
    }));
    const check = service.start();
    expect(service.state()).toMatchObject({
      status: "checking",
      message: "正在获取最新版本信息"
    });
    finishCheck({ isUpdateAvailable: false, updateInfo: { version: "0.12.6" } });
    await check;
  });

  it("uses the GitHub check result even when no updater event is delivered", async () => {
    const { service, fakeUpdater } = updateFixture();
    fakeUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "0.12.7" }
    });
    await service.start();
    expect(service.state()).toMatchObject({
      status: "available",
      latestVersion: "0.12.7"
    });
  });

  it("lets the pre-login UI retry the same automatic updater without opening a browser", async () => {
    const { service, fakeUpdater } = updateFixture();
    await service.start();
    await service.checkNow();
    expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(service.state().status).toBe("current");
  });

  it("leaves an available update optional until the player requests it", async () => {
    const { service, fakeUpdater, releaseSecurity, file } = updateFixture();
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });

    expect(service.state()).toMatchObject({ status: "available", latestVersion: "0.12.7" });
    expect(fakeUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
    await service.verifyAndInstall({ version: "0.12.7", downloadedFile: file });
    expect(releaseSecurity.fetchSignedUpdate).not.toHaveBeenCalled();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.state().status).toBe("available");
  });

  it("downloads, verifies and restarts after the player requests update and restart", async () => {
    const { service, fakeUpdater, releaseSecurity, file } = updateFixture();
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    fakeUpdater.downloadUpdate.mockImplementation(async () => {
      fakeUpdater.emit("update-downloaded", { version: "0.12.7", downloadedFile: file });
      return [file];
    });
    const result = await service.requestUpdate();
    expect(fakeUpdater.downloadUpdate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "installing", latestVersion: "0.12.7" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(releaseSecurity.fetchSignedUpdate).toHaveBeenCalledWith("0.12.7");
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("verifies and installs from the returned installer path when no event is delivered", async () => {
    const { service, fakeUpdater, releaseSecurity, file } = updateFixture();
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    fakeUpdater.downloadUpdate.mockResolvedValue([file]);
    const result = await service.requestUpdate();
    expect(releaseSecurity.fetchSignedUpdate).toHaveBeenCalledWith("0.12.7");
    expect(result).toMatchObject({ status: "installing", latestVersion: "0.12.7" });
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("waits for async verification triggered by update-downloaded before installing", async () => {
    const { service, fakeUpdater, releaseSecurity, file, update } = updateFixture();
    let finishVerification!: (value: typeof update) => void;
    releaseSecurity.fetchSignedUpdate.mockImplementation(() => new Promise(resolve => {
      finishVerification = resolve;
    }));
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    fakeUpdater.downloadUpdate.mockImplementation(async () => {
      fakeUpdater.emit("update-downloaded", { version: "0.12.7", downloadedFile: file });
      return [file];
    });
    const request = service.requestUpdate();
    await Promise.resolve();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    finishVerification(update);
    await request;
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("rejects an installer when the signed GitHub latest version differs", async () => {
    const { service, fakeUpdater, releaseSecurity, file, update } = updateFixture();
    releaseSecurity.fetchSignedUpdate.mockResolvedValue({ ...update, version: "0.12.8" });
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    fakeUpdater.downloadUpdate.mockResolvedValue([file]);
    const result = await service.requestUpdate();
    expect(result.status).toBe("error");
    expect(result.message).toContain("GitHub 最新版本不一致");
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps a verified installer retryable when starting the installer throws", async () => {
    const { service, fakeUpdater, file } = updateFixture();
    fakeUpdater.quitAndInstall.mockImplementation(() => { throw new Error("installer launch failed"); });
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    fakeUpdater.downloadUpdate.mockResolvedValue([file]);
    const result = await service.requestUpdate();
    expect(result).toMatchObject({ status: "ready", installDeferred: false });
    expect(result.message).toContain("安装程序未能启动");
  });

  it("does not restart version checks while an approved download is in progress", async () => {
    const { service, fakeUpdater } = updateFixture();
    let finishDownload!: () => void;
    fakeUpdater.downloadUpdate.mockImplementation(() => new Promise<unknown[]>(resolve => {
      finishDownload = () => resolve([]);
    }));
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });

    const request = service.requestUpdate();
    await Promise.resolve();
    expect(service.state()).toMatchObject({ status: "downloading", latestVersion: "0.12.7" });
    await service.checkNow();
    expect(fakeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(service.state()).toMatchObject({ status: "downloading", latestVersion: "0.12.7" });

    finishDownload();
    await request;
  });

  it("rejects a modified installer and never schedules it for installation", async () => {
    const { service, fakeUpdater, file } = updateFixture();
    writeFileSync(file, "tampered installer", "utf8");
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    await service.requestUpdate();
    await service.verifyAndInstall({ version: "0.12.7", downloadedFile: file });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.state().status).toBe("error");
    expect(service.state().message).toContain("完整性验证");
    expect(service.state().message).toContain("检查网络后重试");
    expect(service.state().message).not.toContain("手动下载安装");
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("defers an authenticated update while a room or account session is active", async () => {
    const { service, fakeUpdater, file } = updateFixture(() => false);
    await service.start();
    fakeUpdater.emit("update-available", { version: "0.12.7" });
    await service.requestUpdate();
    await service.verifyAndInstall({ version: "0.12.7", downloadedFile: file });
    expect(service.state()).toMatchObject({ status: "ready", installDeferred: true });
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
