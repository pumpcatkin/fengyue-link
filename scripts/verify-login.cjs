"use strict";

// Real Electron, local fixtures only; no saved account or platform login is used.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const helpers = require("../electron/login-failover.cjs");
const transport = require("../electron/platform-transport.cjs");
const version = require("../package.json").version;
app.setPath("userData", path.resolve(__dirname, `../release-cache/${version}-validation/login-profile`));

app.whenReady().then(async () => {
  const requests = [];
  let slowProfile = false;
  let profileBusinessError = false;
  const held = new Set();
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/slow-image") {
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    if (request.url === "/login") {
      response.writeHead(200, { "Set-Cookie": "fixture-login=1; HttpOnly; SameSite=Lax; Path=/" });
      response.end("{}");
      return;
    }
    if (request.url === "/go/api/account/profile") {
      if (slowProfile) {
        held.add(response);
        response.on("close", () => held.delete(response));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(profileBusinessError ? { code: 500100, message: "temporary service failure" } : { code: 100000, data: request.headers.cookie?.includes("fixture-login=1")
        ? { id: "fixture-account", username: "fixture" } : { is_trial_account: true, username: "Guest" } }));
      return;
    }
    if (request.url === "/console/api/slow-record") {
      response.setHeader("Content-Type", "application/json");
      setTimeout(() => response.end(JSON.stringify({ data: { authenticated: request.headers.cookie?.includes("fixture-login=1"), method: request.method } })), 200);
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><script id="__NEXT_DATA__" type="application/json">{}</script>
      <form style="display:none"><input name="username"><input type="password" name="password"><button type="submit">Sign in</button></form>
      <form id="actual"><input type="email" placeholder="输入邮箱或用户名"><input type="password"><button type="submit">Sign in</button></form>
      <img src="/slow-image"><script>setTimeout(()=>{
        for (const input of document.querySelectorAll('#actual input')) { input.value=''; input.__reactProps$fixture={}; }
        document.querySelector('#actual').onsubmit=async event=>{
        if (document.querySelector('#actual input').value !== 'fixture') throw new Error('wrong login field');
        event.preventDefault();await fetch('/login',{method:'POST',credentials:'include'});history.pushState({},'','/zh/chats');
      }; }, 600);</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  let credentialsSaved = 0;
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))};AccountBackend`, {
    ...helpers, ...transport, URL, AbortController, setTimeout, clearTimeout, console,
    platformUrlForOrigin: (host, suffix) => new URL(suffix, host),
    discoverDomainStatuses: async () => ({ domains: [] }),
    currentDomainCandidates: () => ({ domains: [{ origin, online: true, latency: 1 }] }),
    TRUSTED_PLATFORM_ORIGINS: new Set([origin]),
    saveSelectedOrigin() {}, saveCredentials() { credentialsSaved += 1; }, clearCredentials() {}
  });
  const windows = [];
  const create = () => {
    const anchor = new BrowserWindow({ show: false, webPreferences: { partition: `login-qa-${windows.length}`, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    windows.push(anchor);
    const instance = Object.create(Backend.prototype);
    Object.assign(instance, {
      origin, anchor, platformSession: anchor.webContents.session, domainSelected: true, account: {}, loggedIn: false, authSessionRevision: 0,
      loginInProgress: false, loginController: null, loginDetectionPaused: false,
      networkReady: Promise.resolve(), mode: "login", appendSessionLog() {}, emit() {},
      clearAuthenticationFailures() {}, verifyOfficialRelease: async () => true, refreshAccount: async () => {}
    });
    return instance;
  };
  const watchdog = setTimeout(() => { console.error("Login fixture did not finish"); app.exit(1); }, 15000);
  try {
    const fast = create();
    const started = Date.now();
    assert.equal(await fast.login({ account: "fixture", password: "fixture-password", remember: true }), true);
    const elapsedMs = Date.now() - started;
    assert.equal(fast.account.accountId, "fixture-account");
    assert.equal(credentialsSaved, 1);
    assert(requests.includes("/slow-image"), "slow image fixture was not loaded");
    assert(held.size > 0, "login should complete before the blocked image finishes");
    assert(elapsedMs < 6000, `login waited on unrelated page resources: ${elapsedMs} ms`);
    profileBusinessError = true;
    assert.equal(await fast.readAccountSnapshot({ includeDetails: false, webContents: fast.anchor.webContents, allowSubresourceLoading: true }), null, "a business error must not log the player out");
    profileBusinessError = false;
    assert(Number.isFinite(await fast.platformServerTime()));
    const pending = fast.platformChatApi("/slow-record", { method: "POST", body: { id: "same-record" } });
    for (let index = 0; index < 200 && !requests.includes("/console/api/slow-record"); index += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert(requests.includes("/console/api/slow-record"), "session transport never reached fixture");
    fast.stopLoginPage();
    const written = await pending;
    assert.equal(written.data.authenticated, true, "main-process transport must use the player's HttpOnly cookies");
    assert.equal(written.data.method, "POST");
    assert.equal(requests.filter(url => url === "/console/api/slow-record").length, 1, "navigation must not duplicate a write");

    slowProfile = true;
    const cancelled = create();
    const login = cancelled.login({ account: "fixture", password: "fixture-password", remember: true });
    for (let index = 0; index < 200 && cancelled.loginProgress?.phase !== "verifying"; index += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cancelled.loginProgress.phase, "verifying");
    const cancelAt = Date.now();
    cancelled.cancelLogin();
    assert.equal((await login).cancelled, true);
    assert(Date.now() - cancelAt < 1000, "cancel waited for network completion");
    assert.equal(cancelled.loggedIn, false);
    assert.equal(credentialsSaved, 1);
    assert.equal(cancelled.loginInProgress, false);
    console.log(JSON.stringify({ passed: true, version, loginMsWithBlockedImage: elapsedMs, cancellationMs: Date.now() - cancelAt, delayedHydrationVerified: true, hiddenFormIgnored: true, sessionCookieVerified: true, writeSurvivedRendererClose: true }));
  } finally {
    clearTimeout(watchdog);
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

app.on("window-all-closed", () => {});
