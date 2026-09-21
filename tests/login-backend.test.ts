import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const helpers = require("../electron/login-failover.cjs");
const transport = require("../electron/platform-transport.cjs");
const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");

function backend() {
  const save = vi.fn();
  const Backend = runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
    ...helpers, ...transport, URL, AbortController, setTimeout, clearTimeout, console,
    accountSignature: (value: unknown) => JSON.stringify(value),
    platformUrlForOrigin: (origin: string, pathname: string) => new URL(pathname, origin),
    discoverDomainStatuses: async () => ({ domains: [] }),
    currentDomainCandidates: () => ({ domains: [{ origin: "https://node.test", online: true, latency: 1 }] }),
    TRUSTED_PLATFORM_ORIGINS: new Set(["https://node.test"]), saveSelectedOrigin: vi.fn(), saveCredentials: save, clearCredentials: vi.fn()
  });
  const instance = Object.create(Backend.prototype);
  Object.assign(instance, {
    loginController: null, loginInProgress: false, loggedIn: false, loginDetectionPaused: false,
    authSessionRevision: 0, domainSelected: true, origin: "https://node.test", mode: "login", account: {},
    emit: vi.fn(), appendSessionLog: vi.fn(), clearAuthenticationFailures: vi.fn(), verifyOfficialRelease: async () => true,
    refreshAccount: vi.fn(async () => {}), networkReady: Promise.resolve()
  });
  return { instance, save };
}

describe("desktop login lifecycle", () => {
  it("waits for the DOM instead of slow images and removes its readiness listener", async () => {
    const { instance } = backend();
    const contents: any = new EventEmitter();
    Object.assign(contents, { getURL: () => "https://node.test/zh/signin", isDestroyed: () => false, loadURL: vi.fn(() => new Promise(() => {})) });
    const task = instance.loadLoginPage({ webContents: contents }, "https://node.test", new AbortController().signal);
    await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledOnce());
    contents.emit("dom-ready");
    await task;
    expect(contents.listenerCount("dom-ready")).toBe(0);
  });

  it("lets a player cancel discovery or release checks without saving credentials", async () => {
    const { instance, save } = backend();
    instance.verifyOfficialRelease = () => new Promise(() => {});
    const attempt = instance.login({ account: "name", password: "secret", remember: true });
    expect(instance.loginInProgress).toBe(true);
    expect(instance.cancelLogin()).toBe(true);
    expect(await attempt).toEqual({ cancelled: true });
    expect(instance.loginInProgress).toBe(false);
    expect(instance.loginController).toBeNull();
    expect(instance.loginDetectionPaused).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("destroys an aborted node page and discards its late authenticated profile", async () => {
    const { instance, save } = backend();
    let profileReturned!: (value: unknown) => void;
    let checking!: () => void;
    const checked = new Promise<void>(resolve => { checking = resolve; });
    const contents = {
      getURL: () => "https://node.test/zh/signin", isLoadingMainFrame: () => false,
      executeJavaScript: vi.fn(async (script: string) => script.includes("setValue(accountElement") ? { ok: true } : { hasToken: false, error: null })
    };
    const anchor = { webContents: contents, isDestroyed: () => false, destroy: vi.fn() };
    Object.assign(contents, { mainFrame: contents });
    instance.anchor = anchor;
    instance.ensureAnchor = async () => anchor;
    instance.readAccountSnapshot = () => { checking(); return new Promise(resolve => { profileReturned = resolve; }); };
    const result = instance.login({ account: "name", password: "secret", remember: true });
    await checked;
    instance.cancelLogin();
    profileReturned({ authenticated: true, username: "name", accountId: "account" });
    expect(await result).toEqual({ cancelled: true });
    expect(instance.loggedIn).toBe(false);
    expect(anchor.destroy).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(instance.mode).toBe("login");
  });

  it("blocks overlapping login submissions and permits retry after cancellation", async () => {
    const { instance } = backend();
    instance.verifyOfficialRelease = () => new Promise(() => {});
    const first = instance.login({ account: "name", password: "secret" });
    await expect(instance.login({ account: "name", password: "secret" })).rejects.toThrow("已经在进行中");
    instance.cancelLogin();
    await first;
    instance.verifyOfficialRelease = async () => true;
    instance.loginAtOrigin = vi.fn(async () => true);
    expect(await instance.login({ account: "name", password: "secret" })).toBe(true);
    expect(instance.loginAtOrigin).toHaveBeenCalledOnce();
  });

  it("commits a valid account and saves credentials only after authentication", async () => {
    const { instance, save } = backend();
    const contents = {
      getURL: () => "https://node.test/zh/signin", isLoadingMainFrame: () => false,
      executeJavaScript: vi.fn(async (script: string) => script.includes("setValue(accountElement") ? { ok: true } : { hasToken: false, error: null })
    };
    const anchor = { webContents: contents, isDestroyed: () => false, destroy: vi.fn(), loadURL: vi.fn(async () => {}) };
    Object.assign(contents, { mainFrame: contents });
    instance.anchor = anchor;
    instance.ensureAnchor = async () => anchor;
    instance.readAccountSnapshot = async () => ({ authenticated: true, username: "name", accountId: "account", email: null });
    expect(await instance.login({ account: "name", password: "secret", remember: true })).toBe(true);
    expect(instance).toMatchObject({ loggedIn: true, loginInProgress: false, originLocked: true, loginDetectionPaused: false, mode: "lobby" });
    expect(save).toHaveBeenCalledOnce();
    expect(anchor.destroy).not.toHaveBeenCalled();
    expect(instance.account.accountId).toBe("account");
  });

  it("does not probe or adopt a background session after cancellation", async () => {
    const { instance } = backend();
    instance.loginDetectionPaused = true;
    instance.readAccountSnapshot = vi.fn(async () => ({ authenticated: true }));
    await instance.refreshLoginState();
    // Call the real prototype method, not the post-login refresh stub.
    await Object.getPrototypeOf(instance).refreshAccount.call(instance);
    expect(instance.readAccountSnapshot).not.toHaveBeenCalled();
    expect(instance.loggedIn).toBe(false);
  });

  it("also closes a third-party sign-in window when cancelled", () => {
    const { instance } = backend();
    instance.oauthWindow = {};
    instance.loginInProgress = true;
    instance.closeOAuthWindows = vi.fn(() => { instance.oauthWindow = null; });
    expect(instance.cancelLogin()).toBe(true);
    expect(instance.closeOAuthWindows).toHaveBeenCalledOnce();
    expect(instance.loginInProgress).toBe(false);
    expect(instance.loginDetectionPaused).toBe(true);
  });

  it("never reloads the account renderer when a heartbeat fails and coalesces concurrent heartbeats", async () => {
    const { instance } = backend();
    instance.anchorNavigationArmed = true;
    instance.anchor = { loadURL: vi.fn() };
    instance.ensureAnchor = vi.fn();
    instance.platformGoApi = vi.fn(async () => { throw new Error("Failed to fetch"); });
    await Promise.all([instance.keepSessionAlive(), instance.keepSessionAlive()]);
    expect(instance.platformGoApi).toHaveBeenCalledOnce();
    expect(instance.ensureAnchor).not.toHaveBeenCalled();
    expect(instance.anchor.loadURL).not.toHaveBeenCalled();
    expect(instance.sessionHeartbeatPromise).toBeNull();
    instance.lastPlatformSuccessAt = Date.now();
    await instance.keepSessionAlive();
    expect(instance.platformGoApi).toHaveBeenCalledOnce();
  });

  it("holds the active game's account through failed authentication probes", async () => {
    const { instance } = backend();
    Object.assign(instance, {
      loggedIn: true, mode: "online-world", account: { accountId: "player" },
      onlineWorldService: { work: { id: "work" } }, confirmAuthenticationFailure: () => true,
      readAccountSnapshot: async () => ({ authenticated: false, reason: "guest-account" }),
      detachSurface: vi.fn()
    });
    await Object.getPrototypeOf(instance).refreshAccount.call(instance);
    expect(instance.loggedIn).toBe(true);
    expect(instance.account.accountId).toBe("player");
    expect(instance.detachSurface).not.toHaveBeenCalled();
  });

  it("shares a platform rate-limit cooldown without sending more requests", async () => {
    const { instance } = backend();
    instance.platformSession = { fetch: vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } })) };
    await expect(instance.platformGoApi("/account/profile")).rejects.toMatchObject({ status: 429 });
    await expect(instance.platformGoApi("/account/profile")).rejects.toMatchObject({ status: 429 });
    expect(instance.platformSession.fetch).toHaveBeenCalledOnce();
  });
});
