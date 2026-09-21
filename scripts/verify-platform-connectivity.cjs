"use strict";

// Opt-in, read-only platform verification using an isolated non-persistent session.
const { app, BrowserWindow, session, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const helpers = require("../electron/login-failover.cjs");
const transport = require("../electron/platform-transport.cjs");
const { OFFICIAL_DOMAIN_DIRECTORY_URLS, mergePublishedOrigins } = require("../electron/domain-directory.cjs");
const { extractCommentItems } = require("../electron/online-world-protocol.cjs");
const { OnlineWorldService } = require("../electron/online-world-service.cjs");
const version = require("../package.json").version;
const live = process.argv.includes("--live");
const credentialsPath = path.join(app.getPath("appData"), "风月联机工具", "credentials", "default.json");
app.setName("风月联机工具");
// Windows safeStorage uses the existing application's encryption metadata.
// Cookies and browsing data still belong exclusively to the temporary partition.
app.setPath("userData", path.join(app.getPath("appData"), "风月联机工具"));
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (!live) throw new Error("Pass --live to test the official platform using the saved account in an isolated session");
  const partition = session.fromPartition(`connectivity-check-${Date.now()}`);
  await partition.setProxy({ mode: "system" });
  partition.webRequest.onCompleted({ urls: ["https://*/*"] }, details => {
    if (details.method === "POST") console.log(JSON.stringify({ stage: "platform-post", path: new URL(details.url).pathname, status: details.statusCode }));
  });
  const directories = await Promise.all(OFFICIAL_DOMAIN_DIRECTORY_URLS.map(async url => {
    const response = await partition.fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    assert(response.ok);
    return { url, html: await response.text() };
  }));
  const origins = mergePublishedOrigins(directories.map(item => item.html));
  const nodes = [];
  for (let index = 0; index < origins.length; index += 3) {
    nodes.push(...await Promise.all(origins.slice(index, index + 3).map(async origin => {
      const started = Date.now();
      try {
        const response = await partition.fetch(`${origin}/zh/signin`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
        const finalOrigin = new URL(response.url || origin).origin;
        await response.body?.cancel();
        const api = await transport.requestPlatformJson({ fetch: partition.fetch.bind(partition), origin, pathname: "/go/api/account/profile", timeout: 5000, attempts: 1 });
        return { origin, finalOrigin, online: response.ok, status: response.status, apiCode: api.payload.code, latency: Date.now() - started };
      } catch (error) { return { origin, online: false, error: error.code || error.message, latency: Date.now() - started }; }
    })));
  }
  console.log(JSON.stringify({ stage: "official-directory-probes", directories: directories.map(item => item.url), uniqueOrigins: origins.length, nodes }));
  const candidates = helpers.orderLoginCandidates(nodes).filter(item => origins.includes(item.origin));
  assert(candidates.length, "no reachable platform node");
  const source = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))};AccountBackend`, {
    ...helpers, ...transport, URL, AbortController, setTimeout, clearTimeout, console,
    platformUrlForOrigin: (origin, suffix) => new URL(suffix, origin),
    discoverDomainStatuses: async () => ({ domains: nodes }),
    currentDomainCandidates: () => ({ domains: nodes }), TRUSTED_PLATFORM_ORIGINS: new Set(origins),
    saveSelectedOrigin() {}, saveCredentials() {}, clearCredentials() {}
  });
  const anchor = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const instance = Object.create(Backend.prototype);
  const events = [];
  Object.assign(instance, {
    origin: candidates[0].origin, anchor, platformSession: partition, domainSelected: true, account: {}, loggedIn: false, authSessionRevision: 0,
    loginInProgress: false, loginController: null, loginDetectionPaused: false,
    networkReady: Promise.resolve(), mode: "login", emit() {}, appendSessionLog(category, detail) {
      events.push({ category, event: detail.event, code: detail.code, elapsedMs: detail.elapsedMs });
      if (category === "login") console.log(JSON.stringify({ stage: "login", event: detail.event, elapsedMs: detail.elapsedMs, error: detail.error }));
    },
    clearAuthenticationFailures() {}, verifyOfficialRelease: async () => true, refreshAccount: async () => {}
  });
  // Recreate only this verifier's window if node failover closes it.
  instance.ensureAnchor = async () => {
    if (!instance.anchor || instance.anchor.isDestroyed()) {
      instance.anchor = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    }
    return instance.anchor;
  };
  const watchdog = setTimeout(() => instance.cancelLogin(), 90000);
  const diagnostic = setInterval(() => {
    const contents = instance.anchor?.webContents;
    if (!contents || contents.isDestroyed()) return;
    void contents.mainFrame.executeJavaScript(`(() => ({ path:location.pathname, title:document.title,
      inputs:[...document.querySelectorAll('input')].map(item=>({type:item.type,name:item.name,id:item.id,visible:item.getClientRects().length>0,disabled:item.disabled,valid:item.validity.valid,typeMismatch:item.validity.typeMismatch,valueLength:item.value.length})),
      alerts:[...document.querySelectorAll('[role="alert"]')].map(item=>(item.textContent||'').slice(0,120)),
      buttons:[...document.querySelectorAll('button')].filter(item=>item.getClientRects().length).map(item=>({text:(item.textContent||'').trim().slice(0,50),type:item.type,inForm:Boolean(item.form)}))
    }))()`).then(page => console.log(JSON.stringify({ stage: "page-status", phase: instance.loginProgress?.phase, page }))).catch(() => {});
  }, 15000);
  try {
    const stored = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    const credentials = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, "base64")));
    const started = Date.now();
    assert.equal(await instance.login({ ...credentials, remember: false, autoLogin: false }), true);
    const loginMs = Date.now() - started;
    clearTimeout(watchdog);
    const card = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../game-cards/猎艳疆土.json"), "utf8"));
    const workId = card.companion.workId || card.companion.appId || new URL(card.companion.url).pathname.split("/").pop();
    const samples = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const before = Date.now();
      const profile = await instance.platformGoApi("/account/profile");
      assert.equal(String(profile.data?.id), instance.account.accountId);
      const page = await instance.platformChatApi(`/comments/${encodeURIComponent(workId)}/1?page=1&limit=50&order=created_at_desc&filter_type=all`);
      const comments = extractCommentItems(page);
      const root = comments.find(item => item.content && item.id);
      const branch = root ? await instance.platformChatApi(`/comments/branches/${encodeURIComponent(root.id)}`) : null;
      samples.push({ pass: pass + 1, elapsedMs: Date.now() - before, rootPageItems: comments.length, branchItems: branch ? extractCommentItems(branch).length : 0 });
    }
    const reader = new OnlineWorldService({
      getAccount: () => instance.account, onChange() {}, cacheFile: null,
      requestConsole: (endpoint, options = {}) => {
        assert(!options.method || options.method === "GET", "Live verification must stay read-only");
        return instance.platformChatApi(endpoint, options);
      }
    });
    reader.work = { id: workId, authorAccountId: card.companion.authorAccountId };
    reader.commentReadSession = { pages: new Map(), branches: new Map(), comments: new Map(), failedRoots: new Map(), totalRoots: null };
    const history = await reader.readHistory(true);
    const incomplete = history.assembled.incomplete.map(item => ({
      id: item.id, kind: item.kind, total: item.total, received: item.received, missing: item.missing,
      sources: item.sources?.map(source => ({ id: source.id, createdAt: source.created_at }))
    }));
    assert.equal(reader.commentReadSession.failedRoots.size, 0, "a cloud branch request failed");
    console.log(JSON.stringify({ stage: "authenticated-read-only", requestsPassed: true, recordsComplete: !incomplete.length, version, origin: instance.origin, loginMs, samples, history: reader.history, records: history.assembled.records.length, incomplete, events }));
  } finally {
    clearTimeout(watchdog);
    clearInterval(diagnostic);
    instance.stopLoginPage();
  }
  app.quit();
}).catch(error => { console.error(error?.message || String(error)); app.exit(1); });
