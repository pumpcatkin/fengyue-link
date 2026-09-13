// Offline integration QA: no user profile, authentication, messages or model calls.
const electron = require("electron");
if (process.type === "renderer") {
  const { contextBridge, ipcRenderer } = electron;
  const names = require("node:fs").readFileSync(require("node:path").join(__dirname, "../electron/preload.cjs"), "utf8").matchAll(/^  (\w+):/gm);
  const api = {};
  for (const [, name] of names) api[name] = name.startsWith("on")
    ? callback => ipcRenderer.on(`qa:${name}`, (_event, value) => callback(value))
    : (...args) => ipcRenderer.invoke("qa:api", name, args);
  contextBridge.exposeInMainWorld("fengyueBackend", api);
  window.addEventListener("error", event => ipcRenderer.send("qa:error", event.message));
  window.addEventListener("unhandledrejection", event => ipcRenderer.send("qa:error", String(event.reason)));
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
  const fs = require("node:fs");
  const path = require("node:path");
  const assert = require("node:assert/strict");
  const vm = require("node:vm");
  const http = require("node:http");
  const workspace = path.resolve(__dirname, "..");
  const root = process.env.FYMP_QA_APP_ROOT || workspace;
  const version = require(path.join(root, "package.json")).version;
  const outputDir = path.join(workspace, "release-cache", `${version}-validation`);
  fs.mkdirSync(outputDir, { recursive: true });
  app.setPath("userData", path.join(outputDir, "electron-profile"));
  const errors = [];
  const calls = [];
  const pipeline = require(path.join(root, "electron/plugin-pipeline.cjs"));
  const split = require(path.join(root, "electron/perspective-split.cjs"));
  let state = {
    loggedIn: true, profileId: "offline-qa", mode: "lobby", uiTheme: "light", origin: "https://staging.aiero.cc", domainSelected: true, originLocked: true,
    releaseSecurity: { status: "development", verified: true, message: "离线界面测试", currentVersion: version },
    account: { accountId: "a", username: "本地测试", level: 10, points: 1000 }, accountLevel: 10,
    work: null, room: null, conversation: { items: [] }, models: { items: [] }, characterProfiles: { items: [{ id: "qa-profile", label: "远征统帅", displayName: "本地测试", basicInfo: "离线界面测试角色", appearance: "" }], selectedId: "qa-profile" },
    plugins: { definitions: [{ id: "effect-judge", ...pipeline.normalizePluginSettings().plugins["effect-judge"] }, { id: "perspective-split", ...pipeline.normalizePluginSettings().plugins["perspective-split"] }], currentRuns: [], lastRuns: [] },
    workSettings: {}
  };
  const domains = { items: [{ origin: state.origin, online: true, latency: 10 }], candidates: [], probing: false };
  ipcMain.on("qa:error", (_event, message) => errors.push(message));
  ipcMain.handle("qa:api", (_event, name, args) => {
    calls.push({ name, args });
    if (name === "getState") return state;
    if (name === "getAppVersion") return version;
    if (name === "getAuthorInfo") return {
      name: "八爪毛米",
      links: {
        homepage: { key: "homepage", label: "作者主页", configured: false, url: null },
        releasePost: { key: "releasePost", label: "风月发布帖", configured: false, url: null },
        feedbackPost: { key: "feedbackPost", label: "问题反馈帖", configured: false, url: null },
        github: { key: "github", label: "GitHub 项目页", configured: true, url: "https://github.com/pumpcatkin/fengyue-link" }
      }
    };
    if (name === "listDomains" || name === "listDomainCandidates") return domains;
    if (name === "getLogs") return [];
    if (name === "listOnlineWorldCards") return { cards: [{ cardId: "cc.aiero.fyow.grid-conquest.official", gameId: "cc.aiero.fyow.grid-conquest", title: "猎艳疆土", version: 7, workId: "b27218e6-80f9-4c0d-91c7-4b8f87d47be8", workName: "猎艳疆土[b27218e680f94c0d]", authorAccountId: "39404f0e-7678-45a1-86c6-9a21116bacbd" }], activeCardId: null };
    if (name === "getOnlineWorldState") return { status: "closed", initialized: false, revision: 0, work: null, program: { source: "builtin-preview", digest: "builtin-preview" } };
    if (name === "setOrigin") return state;
    if (name === "confirmAction") return true;
    if (name === "openOfficialReleasePage") return true;
    if (name === "openAuthorLink") return true;
    if (name === "adaptWorkPrefix") return { sampleCount: 1, points: { total: 0 } };
    return null;
  });
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { preload: __filename, contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
    const evaluate = source => window.webContents.executeJavaScript(source, true);
    const settle = () => new Promise(resolve => setTimeout(resolve, 200));
    try {
      await window.loadFile(path.join(root, "electron/desktop/index.html"));
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#official-notice-overlay').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('#official-notice-title').textContent`), "正在对照版本号");
      assert.equal(await evaluate(`/公钥|指纹/.test(document.querySelector('#official-notice-card').textContent)`), false);
      fs.writeFileSync(path.join(outputDir, "official-notice.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('#official-notice-action').click()`);
      assert.equal(await evaluate(`document.querySelector('#official-notice-overlay').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('#author-name').textContent`), "八爪毛米");
      assert.equal(await evaluate(`document.querySelector('[data-author-link="github"]').disabled`), false);
      assert.equal(await evaluate(`document.querySelector('[data-author-link="homepage"]').disabled`), true);
      await evaluate(`document.querySelector('[data-author-link="github"]').click()`);
      assert(calls.some(call => call.name === "openAuthorLink" && call.args[0] === "github"));
      assert.equal(await evaluate(`document.querySelector('#enter-multiplayer').nextElementSibling.id`), "enter-online-world");
      assert.equal(await evaluate(`document.querySelector('#enter-online-world').nextElementSibling.id`), "edit-profiles");
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').getAttribute('sandbox')`), "allow-scripts");
      await evaluate(`document.querySelector('#enter-online-world').click()`);
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#online-world-page').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('.online-world-library-head h1').textContent`), "联机游戏");
      assert.equal(await evaluate(`document.querySelectorAll('.online-world-card-tile').length`), 1);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#online-world-library-grid')).gridTemplateColumns.split(' ').length`), 5);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "online-world-library.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('.online-world-card-tile[data-card-id="cc.aiero.fyow.grid-conquest.official"]').click()`);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail-title').textContent`), "猎艳疆土");
      assert.equal(await evaluate(`document.querySelector('#online-world-open-form').children.length`), 3);
      assert.equal(await evaluate(`document.querySelector('#online-world-profile').value`), "qa-profile");
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').textContent.includes('b27218e6')`), false);
      window.webContents.send("qa:onOnlineWorldState", { status: "needs-initialization", initialized: false, isAuthor: true, isServerOwner: true, work: { id: "fixture", name: "猎艳疆土[b27218e680f94c0d]" }, program: { source: "card-package", digest: "fixture-owner" } });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-initialize').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#online-world-initialize').textContent`), "服主开服");
      fs.writeFileSync(path.join(outputDir, "online-world-details.png"), (await window.webContents.capturePage()).toPNG());
      const mapFacts = Array.from({ length: 4096 }, (_, index) => ({ x: index % 64, y: Math.floor(index / 64), population: 100 + index % 9901, resourceGrade: ["D-", "C", "B", "A", "S+"][index % 5], resourceRank: index % 15, garrisonCap: 20 + index % 1980, neutralPower: 20 + index % 1980 }));
      const runtime = require(path.join(root, "electron/online-world-runtime.cjs"));
      const gameDirectory = path.join(root, "electron/desktop/online-world/grid-conquest");
      const javascript = `${fs.readFileSync(path.join(gameDirectory, "acg-tags.js"), "utf8")}\n${fs.readFileSync(path.join(gameDirectory, "game.js"), "utf8")}`;
      const programHtml = runtime.injectSandboxCsp(runtime.composeSingleFileProgram(fs.readFileSync(path.join(gameDirectory, "index.html"), "utf8"), fs.readFileSync(path.join(gameDirectory, "styles.css"), "utf8"), javascript));
      window.webContents.send("qa:onOnlineWorldState", { status: "ready", initialized: true, isAuthor: true, isServerOwner: true, revision: 1, card: { cardId: "cc.aiero.fyow.grid-conquest.official", title: "猎艳疆土" }, work: { id: "fixture", name: "猎艳疆土[b27218e680f94c0d]" }, control: { seasonId: "fixture-season" }, account: { accountId: "a", username: "本地测试" }, world: { seed: "fixture", startedAt: Date.now(), revision: 1, bans: {}, playerEpochs: {}, cells: { "4,7": { ownerAccountId: "a", soldiers: 80, generalIds: [] }, "5,7": { ownerAccountId: "b", soldiers: 60, generalIds: [] } }, players: { a: { accountId: "a", displayName: "本地测试", accountName: "本地测试", position: { x: 4, y: 7 }, fieldArmySoldiers: 0, carriedGeneralIds: ["g1"] }, b: { accountId: "b", displayName: "北境玩家", accountName: "north@example" } }, generals: { g1: { id: "g1", name: "青禾", power: 500, holderAccountId: "a", loyalToAccountId: "b", capturedFromAccountId: "b", status: "carried", setting: "善守城，重信义。", masterHistory: [{ accountId: "b", fromYear: 1, toYear: 2 }], captivityHistory: [], interactionHistory: [], memoryText: "言谈：暂无\n经历：[1年]战败被俘" } }, jobs: {} }, directInbox: [{ messageId: "dm1", fromAccountId: "b", type: "general-letter", payload: { generalName: "青禾", text: "愿暂息兵戈，共商边界。" }, createdAt: Date.now() }], mapFacts, serverNow: Date.now(), program: { source: "card-package", digest: "fixture-card-loaded" }, programHtml });
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#online-world-frame').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('#online-world-profile').disabled`), true);
      fs.writeFileSync(path.join(outputDir, "online-world-game.png"), (await window.webContents.capturePage()).toPNG());
      const embeddedGameFrame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith("blob:"));
      assert(embeddedGameFrame, "missing sandboxed online-world frame");
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-command-toggle').classList.contains('hidden')`), false);
      const mapMetrics = await embeddedGameFrame.executeJavaScript(`(()=>{const viewport=document.querySelector('#map-viewport');const canvas=document.querySelector('#map');return{label:document.querySelector('#zoom-label').textContent,visibleColumns:viewport.clientWidth/(canvas.getBoundingClientRect().width/64)}})()`);
      assert.equal(mapMetrics.label, "1×");
      assert(mapMetrics.visibleColumns >= 11 && mapMetrics.visibleColumns <= 13);
      const zoomed = await embeddedGameFrame.executeJavaScript(`(()=>{const viewport=document.querySelector('#map-viewport');viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));return document.querySelector('#zoom-label').textContent})()`);
      assert.equal(zoomed, "1.25×");
      const panned = await embeddedGameFrame.executeJavaScript(`(()=>{const viewport=document.querySelector('#map-viewport');viewport.scrollTo(1000,1000);viewport.setPointerCapture=()=>{};viewport.hasPointerCapture=()=>false;viewport.dispatchEvent(new PointerEvent('pointerdown',{button:2,pointerId:7,clientX:500,clientY:500,bubbles:true}));viewport.dispatchEvent(new PointerEvent('pointermove',{button:2,buttons:2,pointerId:7,clientX:400,clientY:420,bubbles:true}));viewport.dispatchEvent(new PointerEvent('pointerup',{button:2,pointerId:7,clientX:400,clientY:420,bubbles:true}));return viewport.scrollLeft>1000&&viewport.scrollTop>1000})()`);
      assert.equal(panned, true);
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#return-library').click()`);
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#online-world-setup').classList.contains('hidden')`), true);
      await evaluate(`document.querySelector('#online-world-back').click()`);
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#home-page').classList.contains('hidden')`), true);
      state = { ...state, settingsVisible: true };
      const settingsWindow = new BrowserWindow({ show: false, width: 370, height: 720, webPreferences: { preload: __filename, contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
      try {
        await settingsWindow.loadFile(path.join(root, "electron/desktop/index.html"), { query: { settingsOverlay: "1" } });
        await settle();
        assert.equal(await settingsWindow.webContents.executeJavaScript(`!document.querySelector('#settings-popover').classList.contains('hidden')`, true), true);
        assert.equal(await settingsWindow.webContents.executeJavaScript(`document.querySelector('#author-name').textContent`, true), "八爪毛米");
        fs.writeFileSync(path.join(outputDir, "author-info.png"), (await settingsWindow.webContents.capturePage()).toPNG());
      } finally {
        settingsWindow.destroy();
        state = { ...state, settingsVisible: false };
      }
      await evaluate(`document.querySelector('#enter-multiplayer').click()`);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#placeholder-title').textContent`), "点击此处选择作品");
      assert.equal(await evaluate(`document.querySelector('[data-tab="members"]')`), null);
      assert.equal(await evaluate(`document.querySelector('#member-list').closest('[data-panel]').dataset.panel`), "room");
      assert.equal(await evaluate(`document.querySelector('.surface-switcher').closest('header').classList.contains('topbar')`), true);
      assert.equal(await evaluate(`document.querySelector('#model-card').closest('[data-panel]').dataset.panel`), "work");
      assert.equal(await evaluate(`document.querySelector('#conversation-card').closest('[data-panel]').dataset.panel`), "work");
      await evaluate(`document.querySelector('#surface-slot').click()`);
      await settle();
      assert(calls.some(call => call.name === "chooseWork"));
      fs.writeFileSync(path.join(outputDir, "empty-lobby.png"), (await window.webContents.capturePage()).toPNG());
      state = { ...state, work: { title: "示例作品", suffix: "/zh/explore/installed/test" }, conversation: { items: [{ id: "c", name: "示例会话", active: true }], activeName: "示例会话" }, workSettings: { appId: "test", global: { pre_prompt: "作品原有全局配置", pre_text: "作品原有前置词", post_text: "" }, memoryCount: 6, characters: 16 } };
      window.webContents.send("qa:onState", state);
      await settle();
      await evaluate(`document.querySelector('[data-tab="work"]').click(); document.querySelector('#work-global-details').open=true`);
      await settle();
      fs.writeFileSync(path.join(outputDir, "work-settings.png"), (await window.webContents.capturePage()).toPNG());
      assert.equal(await evaluate(`document.querySelector('#work-global-prompt').value`), "作品原有全局配置");
      await evaluate(`document.querySelector('[data-tab="plugins"]').click(); document.querySelector('#perspective-split-card').open=true`);
      assert.equal(await evaluate(`document.querySelector('[data-panel="plugins"]').firstElementChild.textContent`), "插件不一定适合所有作品，请根据具体情况进行尝试或使用");
      assert.equal(await evaluate(`document.querySelector('#perspective-split-card .plugin-cost-warning').textContent.includes('Gemini Flash、DeepSeek V4 Flash')`), true);
      await settle();
      fs.writeFileSync(path.join(outputDir, "perspective-plugin.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('#prefix-adapter-card').open=true;document.querySelector('#adapt-work-prefix').click()`);
      await settle();
      assert(calls.some(call => call.name === "confirmAction" && call.args[0].title === "多人格式适配"));
      assert(calls.some(call => call.name === "adaptWorkPrefix"));
      state = { ...state, prefixAdapter: { status: "ready", workTitle: "示例作品" } };
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#prefix-adapter-summary-state').textContent`), "当前对话已适配");
      assert.equal(await evaluate(`document.querySelector('#prefix-adapter-status').textContent`), "当前对话已适配");
      await evaluate(`document.querySelector('[data-tab="work"]').click(); document.querySelector('#rename-conversation').click()`);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#conversation-rename-form')).display !== 'none'`), true);
      await evaluate(`document.querySelector('#conversation-rename-value').value='新的平台名称'; document.querySelector('#conversation-rename-form').requestSubmit()`);
      await settle();
      assert(calls.some(call => call.name === "renameConversation" && call.args[0] === "c" && call.args[1] === "新的平台名称"));
      await evaluate(`document.querySelector('#delete-conversation').click()`);
      await settle();
      assert(calls.some(call => call.name === "deleteConversation" && call.args[0] === "c"));
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#toast')).boxShadow`), "none");
      state = { ...state, room: { role: "guest", status: "waiting", id: "r", members: [{ id: "a", displayName: "本人不显示", basicInfo: "自己的秘密", appearance: "自己的外貌" }, { id: "b", displayName: "小丽", basicInfo: "隐藏基础秘密", appearance: "红色衣服\n蓝色帽子" }], round: { status: "collecting" } } };
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#work-global-prompt').readOnly`), true);
      assert.equal(await evaluate(`document.querySelector('#save-work-global').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('#perspective-split-enabled').disabled`), true);
      await evaluate(`document.querySelector('[data-tab="room"]').click()`);
      assert.equal(await evaluate(`document.querySelector('[data-tab].active').dataset.tab`), "room");
      assert.equal(await evaluate(`document.querySelectorAll('#member-list .member-card').length`), 1);
      assert.equal(await evaluate(`/本人不显示|自己的秘密|自己的外貌|隐藏基础秘密/.test(document.querySelector('#member-list').textContent)`), false);
      assert.equal(await evaluate(`document.querySelector('.member-appearance').open`), false);
      await evaluate(`document.querySelector('.member-appearance').open=true`);
      await settle();
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('.member-appearance').open`), true);
      assert.equal(await evaluate(`document.querySelector('.member-appearance p').textContent`), "红色衣服\n蓝色帽子");
      fs.writeFileSync(path.join(outputDir, "members.png"), (await window.webContents.capturePage()).toPNG());
      state = { ...state, mode: "guest-waiting", backgroundPages: { liveGameView: true, gameReady: true, gamePresentationAllowed: false } };
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('.stage-placeholder').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#game-frame').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "guest-waiting.png"), (await window.webContents.capturePage()).toPNG());
      const navigationCallStart = calls.length;
      state = { ...state, mode: "lobby", room: { ...state.room, role: "host", status: "waiting" } };
      window.webContents.send("qa:onState", state);
      await settle();
      await evaluate(`document.querySelector('#back-home').click()`);
      await settle();
      const navigationCalls = calls.slice(navigationCallStart);
      assert(navigationCalls.some(call => call.name === "confirmAction" && call.args[0].title === "返回主页" && call.args[0].acceptText === "解散并返回"));
      assert(navigationCalls.some(call => call.name === "leaveRoom"));
      assert(navigationCalls.some(call => call.name === "hidePlatform"));
      assert.equal(await evaluate(`!document.querySelector('#home-page').classList.contains('hidden')`), true);
      state = { ...state, releaseSecurity: { status: "update-required", verified: false, message: "发现官方新版本 v9.9.9", currentVersion: version, latestVersion: "9.9.9" } };
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#official-notice-title').textContent`), "请更新版本");
      assert.equal(await evaluate(`document.querySelector('#official-notice-action').textContent`), "退出工具");
      assert.equal(await evaluate(`/公钥|指纹/.test(document.querySelector('#official-notice-card').textContent)`), false);
      fs.writeFileSync(path.join(outputDir, "official-update-required.png"), (await window.webContents.capturePage()).toPNG());
      assert.deepEqual(errors, []);

      // Exercise the real Electron response interceptor against a local fixture.
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", req.url.startsWith("/installed-apps/") ? "application/json" : "text/html");
        res.end(req.url.startsWith("/installed-apps/") ? JSON.stringify({ data: [{ id: "m", answer: "ALL PLAYERS", query: "q" }] }) : "<!doctype html><title>Offline response test</title>");
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
      try {
        const source = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
        const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))};AccountBackend`, { ...split, ...pipeline, URL, Buffer });
        const instance = Object.create(Backend.prototype);
        instance.room = { role: "host" };
        const nativeView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
        window.contentView.addChildView(nativeView);
        instance.window = window;
        instance.gameSurface = nativeView;
        instance.liveGameSurface = true;
        instance.mode = "game";
        instance.surfaceBounds = { x: 400, y: 150, width: 600, height: 400 };
        instance.gameSurfacePresentationLocks = 0;
        instance.keepSettingsSurfaceOnTop = () => {};
        instance.room = { role: "guest", round: { status: "collecting" } };
        instance.keepGameSurfaceResident();
        assert.equal(nativeView.getBounds().x, 400);
        instance.beginGuestOutputWait(1);
        assert.equal(nativeView.getBounds().x, -32000);
        instance.room.round.status = "collecting";
        instance.keepGameSurfaceResident();
        assert.equal(nativeView.getBounds().x, -32000);
        instance.room.verifiedOutputRound = 1;
        instance.keepGameSurfaceResident();
        assert.equal(nativeView.getBounds().x, 400);
        window.contentView.removeChildView(nativeView);
        nativeView.webContents.close();
        instance.room = { role: "host" };
        instance.gameSurface = page;
        instance.perspectiveViews = { "app:c": { [split.outputFingerprint("ALL PLAYERS")]: "OWN VIEW" } };
        instance.appendSessionLog = (_type, error) => errors.push(error);
        await page.loadURL(`http://127.0.0.1:${server.address().port}/`);
        await instance.installPerspectiveResponseFilter();
        const visible = await page.webContents.executeJavaScript(`fetch('/installed-apps/app/messages?conversation_id=c').then(r=>r.json())`);
        assert.equal(visible.data[0].answer, "OWN VIEW");
        assert.equal(visible.data[0].query, "q");
        const raw = await fetch(`http://127.0.0.1:${server.address().port}/installed-apps/app/messages?conversation_id=c`).then(r => r.json());
        assert.equal(raw.data[0].answer, "ALL PLAYERS");
        instance.uiTheme = "light";
        await instance.applyPlatformTheme(page.webContents);
        assert.equal(await page.webContents.executeJavaScript(`document.documentElement.classList.contains('light') && localStorage.getItem('theme') === 'light'`), true);
        instance.uiTheme = "dark";
        await instance.applyPlatformTheme(page.webContents);
        assert.equal(await page.webContents.executeJavaScript(`document.documentElement.classList.contains('dark') && localStorage.getItem('theme') === 'dark'`), true);
        instance.ensureGameSurfaceMounted = async () => true;
        instance.appendSessionLog = () => {};
        await page.webContents.executeJavaScript(`document.body.innerHTML='<div class="chat-container"><div id="question-row"><div id="customized-question-content">input</div></div><div id="answer-row"><div id="ai-chat-answer">OWN VIEW</div></div></div>'`);
        const card = await instance.injectConversationPluginCards({ round: 1, input: "input", runs: [{ runId: "output-1", pluginId: "perspective-split", phase: "output", name: "独立视角", status: "completed", memberCount: 2, points: { total: 12 }, order: 100 }] });
        assert.equal(card.inserted, 1);
        assert.equal(await page.webContents.executeJavaScript(`document.querySelector('#answer-row').nextElementSibling?.dataset.fympToolPhase`), "output");
        await page.webContents.executeJavaScript(`window.__fympRestoreToolCards(); window.__fympRestoreToolCards()`);
        assert.equal(await page.webContents.executeJavaScript(`document.querySelectorAll('[data-fymp-conversation-tool]').length`), 1);
        assert.deepEqual(errors, []);
      } finally { page.destroy(); server.close(); }
      fs.writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({ passed: true, version, electron: process.versions.electron, errors, checks: ["branded official notice", "hidden first-run verification result dialog", "online world entry and sandbox", "lobby selection", "tab and member placement", "appearance privacy and collapse state", "native confirmation IPC", "conversation management UI wiring", "guest native view and frame gating", "plugin UI", "guest read-only", "real response projection", "server original preserved", "platform theme storage and DOM", "output card anchor and idempotence"] }, null, 2));
      console.log("Offline desktop integration QA passed: " + outputDir);
      window.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      console.error(errors);
      fs.writeFileSync(path.join(outputDir, "failure.txt"), String(error?.stack || error) + "\n" + JSON.stringify(errors));
      window.destroy();
      app.exit(1);
    }
  });
}
