"use strict";
// Runs the production adapter and preload against an isolated local stream.
const { app, BrowserWindow, ipcMain, net } = require("electron");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), vm = require("node:vm"), assert = require("node:assert/strict");
const workspace = path.resolve(__dirname, "..");
const root = process.env.FYMP_QA_APP_ROOT || workspace;
const router = require(path.join(root, "electron/auto-model-router.cjs"));
const prompts = require(path.join(root, "electron/multiplayer-prompts.cjs"));
const { requestFreshModel } = require(path.join(root, "electron/fresh-model-request.cjs"));
const source = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const version = require(path.join(root, "package.json")).version;
const output = path.join(workspace, "output", `prefix-adapter-${version}`);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.on("window-all-closed", () => {});
let persisted = { adapters: { work: { fragment: "original" } } }, saves = 0;
const suggestion = { schema: prompts.PREFIX_ADAPTER_SCHEMA, roster_rule: "保留原有容器，在状态区之前按设定名排列参与者并沿用现有字体。", status_rule: "保留原有状态字段和样式，按设定名分别复制状态容器。", detected_status_bar: true };
const Backend = vm.runInNewContext(source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;")) + ";AccountBackend", {
  ...router, ...prompts, requestFreshModel, crypto: require("node:crypto"), AbortController, setInterval, clearInterval, setTimeout, clearTimeout,
  PREFIX_ADAPTER_APP_ID: "adapter", resolvedModelPointUsage: () => null,
  loadPrefixAdapters: () => JSON.parse(JSON.stringify(persisted)),
  writePrefixAdapters: value => { persisted = value; saves++; }
});
let backend, window;
const snapshot = () => ({
  loggedIn: true, profileId: "adapter-qa", mode: "lobby", uiTheme: "dark", settingsVisible: true,
  origin: backend?.origin || "http://127.0.0.1", domainSelected: true, originLocked: true,
  releaseSecurity: { status: "development", verified: true, currentVersion: version },
  account: { accountId: "qa", username: "QA", level: 10, points: 100000 }, accountLevel: 10,
  work: { suffix: "work", title: "Fixture" }, room: null, conversation: { items: [] }, models: { items: [] },
  characterProfiles: { items: [] }, plugins: { definitions: [], currentRuns: [], lastRuns: [] }, workSettings: {},
  prefixAdapter: { status: backend?.prefixAdapterBusy ? "adapting" : backend?.prefixAdapterOperation?.stage || "missing", stage: backend?.prefixAdapterOperation?.stage },
  modelOperations: [...(backend?.autoModelJobs?.values() || [])].map(job => ({ ...job.state }))
});
const handlers = {
  "backend:get-state": snapshot, "app:get-version": () => version, "app:get-release-channel": () => "official",
  "app:get-author-info": () => ({ name: "QA", links: {} }), "credentials:load": () => null,
  "backend:list-domains": () => ({ items: [], candidates: [] }), "backend:list-domain-candidates": () => ({ items: [], candidates: [] }),
  "online-world:get-state": () => ({ status: "closed" }), "online-world:list-cards": () => ({ cards: [] }),
  "backend:cancel-model-requests": (_event, target) => backend.cancelAutoModels(null, target),
  "backend:set-settings-visible": snapshot, "backend:set-bounds": () => true,
  "backend:set-theme": snapshot
};
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
app.whenReady().then(async () => {
  let server, activeResponse, taskReady, stopped, stopCount = 0, requests = [], complete = false;
  try {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => raw += chunk);
      req.on("end", () => {
        const payload = JSON.parse(raw || "{}");
        if (req.url.endsWith("/chat-stop")) {
          assert.equal(payload.task_id, "fixture-task"); stopCount++;
          res.setHeader("Content-Type", "application/json"); res.end('{"code":100000}'); stopped(); return;
        }
        assert.equal(req.url, "/go/api/apps/chat-messages");
        assert.equal(payload.app_id, "adapter");
        assert.equal(payload.conversation_id, undefined);
        requests.push(payload);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (complete) {
          res.end(`data: ${JSON.stringify({ event: "message", answer: JSON.stringify(suggestion), task_id: "success-task", message_id: "success-message", conversation_id: "success-conversation" })}\n\ndata: {"event":"message_end"}\n\n`);
          return;
        }
        res.write('data: {"event":"message","answer":"in progress","task_id":"fixture-task","message_id":"fixture-message","conversation_id":"fixture-conversation"}\n\n');
        activeResponse = res;
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    backend = Object.assign(Object.create(Backend.prototype), {
      origin: `http://127.0.0.1:${server.address().port}`, account: { accountId: "qa", points: 100000 },
      loggedIn: true, work: { suffix: "work", title: "Fixture" }, room: null, authSessionRevision: 1,
      autoModelJobs: new Map(), autoModelQueues: new Map(), prefixAdapters: { adapters: { work: { fragment: "original" } } },
      currentWorkAppId: () => "work", assertToolLoggedIn: () => {},
      collectPrefixAdapterSamples: async () => [{ conversation_id: "sample", conversation_name: "Fixture", last_ai_reply: "fixture sample" }],
      platformGoApi: async () => ({ models: [{ provider_name: "fixture", model_id: "fixture-model" }] }),
      configureAutomaticModel: async () => {}, refreshOnlineWorldPoints: async () => null, recordAutomaticModelUsage: () => {},
      ensureAnchor: async () => ({ webContents: { isLoading: () => false, executeJavaScript: async () => "", session: { fetch: (url, options) => net.fetch(url, options) } } }),
      appendSessionLog: (_kind, detail) => { if (detail.event === "task-received") taskReady(); },
      emit: () => { if (window && !window.isDestroyed()) window.webContents.send("backend:state", snapshot()); }
    });
    const checks = [];
    for (const overlay of [false, true]) {
      window = new BrowserWindow({ show: false, width: overlay ? 390 : 1280, height: 820, webPreferences: {
        preload: path.join(root, "electron/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
      } });
      await window.loadFile(path.join(root, "electron/desktop/index.html"), { query: overlay ? { settingsOverlay: "1" } : {} });
      await window.webContents.executeJavaScript(`document.querySelector('#official-notice-action').click();null;`);
      const received = new Promise(resolve => taskReady = resolve), stopAck = new Promise(resolve => stopped = resolve);
      const previous = backend.prefixAdapters;
      const pending = backend.adaptCurrentWorkPrefix();
      pending.catch(() => {});
      await received;
      backend.emit();
      await window.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await window.webContents.executeJavaScript(`document.querySelector('#official-notice-action').click();null;`);
      const geometry = await window.webContents.executeJavaScript(`(()=>{const b=document.querySelector('#model-loading-cancel'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,right:r.right,width:innerWidth,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id,disabled:b.disabled}})()`);
      assert.equal(geometry.hit, "model-loading-cancel"); assert.equal(geometry.disabled, false); assert(geometry.x > 0 && geometry.right <= geometry.width);
      fs.writeFileSync(path.join(output, overlay ? "settings-cancel.png" : "main-cancel.png"), (await window.webContents.capturePage()).toPNG());
      window.webContents.debugger.attach("1.3");
      for (const type of ["mousePressed", "mouseReleased"]) await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: geometry.x, y: geometry.y, button: "left", clickCount: 1 });
      await assert.rejects(pending, error => error.name === "AbortError");
      await stopAck;
      assert.equal(backend.prefixAdapterBusy, false); assert.equal(backend.autoModelJobs.size, 0);
      assert.equal(backend.prefixAdapters, previous); assert.equal(backend.prefixAdapterOperation.stage, "cancelled");
      activeResponse.end();
      checks.push({ overlay, clicked: true, cancelled: true });
      window.destroy(); window = null;
    }
    assert.equal(requests.length, 2); assert.equal(stopCount, 2);
    assert.equal(saves, 0);
    complete = true;
    const result = await backend.adaptCurrentWorkPrefix();
    assert.equal(saves, 1); assert.equal(backend.prefixAdapterOperation.stage, "ready");
    assert.equal(result.sampleCount, 1); assert.equal(result.points, null);
    assert.equal(persisted.adapters.work.rosterRule, suggestion.roster_rule);
    checks.push({ completed: true, persisted: true, pointsUnknown: true });
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, version, checks, stopCount, requests: requests.length }, null, 2));
    console.log("PREFIX ADAPTER QA PASSED: successful adaptation, native clicks, cancellation, server stop, retained original prefix");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { activeResponse?.end(); window?.destroy(); server?.close(); app.exit(process.exitCode || 0); }
});
