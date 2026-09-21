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
  let onlineWorldFixture = null;
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
        homepage: { key: "homepage", label: "作者主页", configured: true, url: "https://staging.aiero.cc/zh/profile/39404f0e-7678-45a1-86c6-9a21116bacbd" },
        releasePost: { key: "releasePost", label: "风月发布帖", configured: false, url: null },
        feedbackPost: { key: "feedbackPost", label: "问题反馈帖", configured: false, url: null },
        github: { key: "github", label: "GitHub 下载页", configured: true, url: "https://github.com/pumpcatkin/fengyue-link/releases/latest" }
      }
    };
    if (name === "listDomains" || name === "listDomainCandidates") return domains;
    if (name === "getLogs") return [];
    if (name === "listOnlineWorldCards") return { cards: [{ cardId: "cc.aiero.fyow.grid-conquest.official", gameId: "cc.aiero.fyow.grid-conquest", title: "猎艳疆土", version: 26, workId: "b27218e6-80f9-4c0d-91c7-4b8f87d47be8", workName: "猎艳疆土[b27218e680f94c0d]", authorAccountId: "39404f0e-7678-45a1-86c6-9a21116bacbd", isCurrentUserAuthor: true }], activeCardId: null };
    if (name === "getOnlineWorldState") return onlineWorldFixture || { status: "closed", initialized: false, revision: 0, work: null, program: { source: "builtin-preview", digest: "builtin-preview" } };
    if (name === "openOnlineWorld") return onlineWorldFixture;
    if (name === "syncOnlineWorld") return { ...onlineWorldFixture, status: "ready", syncing: false };
    if (name === "closeOnlineWorld") return { ...onlineWorldFixture, status: "closed", syncing: false };
    if (name === "updateOnlineWorldPreferences") {
      onlineWorldFixture = {
        ...onlineWorldFixture,
        localPreferences: {
          ...(onlineWorldFixture?.localPreferences || {}),
          orientation: args[0]?.orientation || "any",
          characterTags: args[0]?.characterTags || []
        }
      };
      return onlineWorldFixture;
    }
    if (name === "exportOnlineWorldCard") return { canceled: true };
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
      assert.equal(await evaluate(`document.querySelector('#official-notice-overlay').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#official-notice-title').textContent`), "正在获取最新版本信息");
      assert.equal(await evaluate(`/公钥|指纹/.test(document.querySelector('#official-notice-card').textContent)`), false);
      assert.equal(await evaluate(`!document.querySelector('#home-page').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "startup-login-ready.png"), (await window.webContents.capturePage()).toPNG());
      window.webContents.send("qa:onState", { ...state, loggedIn: false, loginInProgress: true, loginCancellable: true, loginProgress: { phase: "connecting", origin: "https://login-node.example" } });
      await settle();
      await evaluate(`document.querySelector('#official-notice-action').click()`);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#cancel-login').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#cancel-login').disabled`), false);
      assert.equal(await evaluate(`document.querySelector('#login-account').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('#login-password').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('#login-progress').textContent`), "正在连接 · login-node.example");
      assert.equal(await evaluate(`document.querySelector('#clear-credentials').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "login-cancellable.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('#cancel-login').click()`);
      await settle();
      assert(calls.some(call => call.name === "cancelLogin"), "cancel login did not reach IPC");
      window.webContents.send("qa:onState", { ...state, loggedIn: false, loginInProgress: false, loginCancellable: false, loginProgress: null });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#cancel-login').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('#login-account').disabled`), false);
      assert.equal(await evaluate(`document.querySelector('#login-password').disabled`), false);
      window.webContents.send("qa:onState", { ...state, modelOperations: [{ id: "model-qa", label: "将领交互", stage: "waiting", model: "deepseek-v4.1-flash", attempt: 8, retryAfterMs: 2000, points: 12 }] });
      await settle();
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#model-loading')).display`), "flex");
      assert.equal(await evaluate(`/第 8 次尝试|deepseek|重试/.test(document.querySelector('#model-loading').textContent)`), false);
      assert.equal(await evaluate(`document.querySelector('#model-loading-detail').textContent.includes('已消耗 12 积分')`), true);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.model-loading-logo')).animationName`), "model-loading-spin");
      fs.writeFileSync(path.join(outputDir, "auto-model-loading.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('#model-loading-cancel').click()`);
      assert(calls.some(call => call.name === "cancelModelRequests"));
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#model-loading')).display`), "none");
      assert.equal(await evaluate(`document.querySelector('#author-name').textContent`), "八爪毛米");
      assert.equal(await evaluate(`document.querySelector('[data-author-link="github"]').disabled`), false);
      assert.equal(await evaluate(`document.querySelector('[data-author-link="homepage"]').disabled`), false);
      await evaluate(`document.querySelector('[data-author-link="github"]').click()`);
      assert(calls.some(call => call.name === "openAuthorLink" && call.args[0] === "github"));
      assert.equal(await evaluate(`document.querySelector('#enter-multiplayer').nextElementSibling.id`), "enter-online-world");
      assert.equal(await evaluate(`document.querySelector('#enter-online-world').nextElementSibling.id`), "edit-profiles");
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').getAttribute('sandbox')`), "allow-scripts");
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').getAttribute('allow')`), "autoplay");
      await evaluate(`document.querySelector('#enter-online-world').click()`);
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#online-world-page').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('.online-world-library-head h1').textContent`), "游戏库");
      assert.equal(await evaluate(`document.querySelectorAll('.online-world-card-tile').length`), 1);
      assert.equal(await evaluate(`document.querySelectorAll('.online-world-library-list-item').length`), 1);
      assert.equal(await evaluate(`document.querySelector('#online-world-featured')`), null);
      assert.equal(await evaluate(`document.querySelector('#online-world-shelf-count').textContent`), "1 个游戏");
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#online-world-library-grid')).gridTemplateColumns.split(' ').length >= 4`), true);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('#online-world-export-card')`), null);
      assert.equal(await evaluate(`document.querySelectorAll('.online-world-author-badge').length`), 1);
      await evaluate(`document.querySelector('.online-world-author-badge').click()`);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').classList.contains('hidden')`), true);
      await settle();
      fs.writeFileSync(path.join(outputDir, "game-card-author-menu.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('.online-world-author-menu [role="menuitem"]').click()`);
      await settle();
      assert(calls.some(call => call.name === "exportOnlineWorldCard" && call.args[0] === "cc.aiero.fyow.grid-conquest.official"));
      fs.writeFileSync(path.join(outputDir, "online-world-library.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('.online-world-card-tile[data-card-id="cc.aiero.fyow.grid-conquest.official"]').click()`);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#online-world-detail-title').textContent`), "猎艳疆土");
      assert.equal(await evaluate(`document.querySelector('#online-world-open-form').children.length`), 3);
      assert.equal(await evaluate(`document.querySelector('#online-world-profile').value`), "qa-profile");
      assert.equal(await evaluate(`document.querySelector('#online-world-detail').textContent.includes('b27218e6')`), false);
      window.webContents.send("qa:onOnlineWorldState", { status: "needs-initialization", initialized: false, isAuthor: true, isServerOwner: true, work: { id: "fixture", name: "猎艳疆土[b27218e680f94c0d]" }, program: { source: "card-package", digest: "fixture-owner" } });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-initialize, #online-world-activate-program, #online-world-migrate, #online-world-status')`), null);
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "online-world-details.png"), (await window.webContents.capturePage()).toPNG());
      window.webContents.send("qa:onOnlineWorldState", { status: "opening", initialized: true, isServerOwner: true,
        loadProgress: { schema: "fyow.load-progress/1", active: true, phase: "reading", readComments: 120, totalComments: null } });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-loading-count').textContent`), "已读取 120 条数据");
      window.webContents.send("qa:onOnlineWorldState", { status: "opening", initialized: true, isServerOwner: true,
        loadProgress: { schema: "fyow.load-progress/1", active: true, phase: "reading", readComments: 120, totalComments: 480 } });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-loading').classList.contains('hidden')`), false);
      assert.equal(await evaluate(`document.querySelector('#online-world-loading-progress').value`), 25);
      assert.equal(await evaluate(`document.querySelector('#online-world-loading-count').textContent`), "120 / 480 条数据");
      assert.equal(await evaluate(`document.querySelector('#online-world-loading').textContent.includes('评论')`), false);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#online-world-loading-title')).color`), "rgb(238, 242, 244)");
      assert.equal(await evaluate(`document.querySelector('#online-world-loading').textContent.includes('猎艳疆土')`), false);
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "cloud-comment-progress.png"), (await window.webContents.capturePage()).toPNG());
      window.webContents.send("qa:onOnlineWorldState", { status: "opening", initialized: true, isServerOwner: true,
        loadProgress: { schema: "fyow.load-progress/1", active: true, phase: "validating", readComments: 480, totalComments: 480 } });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-loading-progress').value`), 99);
      assert.equal(await evaluate(`document.querySelector('#online-world-loading-title').textContent`), "正在校验云端数据");
      const mapFacts = Array.from({ length: 4096 }, (_, index) => ({ x: index % 64, y: Math.floor(index / 64), population: 100 + index % 9901, resourceGrade: ["D-", "C", "B", "A", "S+"][index % 5], resourceRank: index % 15, garrisonCap: 20 + index % 1980, neutralPower: 20 + index % 1980 }));
      const runtime = require(path.join(root, "electron/online-world-runtime.cjs"));
      const gameDirectory = path.join(root, "electron/desktop/online-world/grid-conquest");
      const javascript = `${fs.readFileSync(path.join(gameDirectory, "acg-tags.js"), "utf8")}\n${fs.readFileSync(path.join(gameDirectory, "game.js"), "utf8")}`;
      const programHtml = runtime.injectSandboxCsp(runtime.composeSingleFileProgram(fs.readFileSync(path.join(gameDirectory, "index.html"), "utf8"), fs.readFileSync(path.join(gameDirectory, "styles.css"), "utf8"), javascript));
      window.webContents.send("qa:onOnlineWorldState", { status: "ready", initialized: true, isAuthor: true, isServerOwner: true, revision: 1, card: { cardId: "cc.aiero.fyow.grid-conquest.official", title: "猎艳疆土" }, work: { id: "fixture", name: "猎艳疆土[b27218e680f94c0d]" }, control: { seasonId: "fixture-season" }, account: { accountId: "a", username: "本地测试", points: "1876" }, world: { seed: "fixture", startedAt: Date.now(), revision: 1, bans: {}, playerEpochs: {}, cells: { "4,7": { ownerAccountId: "a", soldiers: 80, generalIds: [] }, "5,7": { ownerAccountId: "b", soldiers: 60, generalIds: [] } }, players: { a: { accountId: "a", displayName: "本地测试", accountName: "本地测试", position: { x: 4, y: 7 }, fieldArmySoldiers: 0, carriedGeneralIds: ["g1", "g2", "g3"] }, b: { accountId: "b", displayName: "北境玩家", accountName: "north@example" } }, generals: { g1: { id: "g1", name: "青禾", power: 500, holderAccountId: "a", loyalToAccountId: "b", capturedFromAccountId: "b", status: "carried", setting: "善守城，重信义。", masterHistory: [{ accountId: "b", fromYear: 1, toYear: 2 }], captivityHistory: [], interactionHistory: [], memoryText: "言谈：暂无\n经历：[1年]战败被俘" }, g2: { id: "g2", name: "长风", power: 470, holderAccountId: "a", loyalToAccountId: "a", status: "carried", setting: "乐观果断，精于奔袭。", masterHistory: [], captivityHistory: [], interactionHistory: [], memoryText: "" }, g3: { id: "g3", name: "照雪", power: 460, holderAccountId: "a", loyalToAccountId: "a", status: "carried", setting: "沉静敏锐，善察地势。", masterHistory: [], captivityHistory: [], interactionHistory: [], memoryText: "" } }, jobs: {} }, directInbox: [{ messageId: "dm1", fromAccountId: "b", type: "general-letter", payload: { generalName: "青禾", text: "愿暂息兵戈，共商边界。" }, createdAt: Date.now() }], modelUsageEvents: [{ id: 1, task: "general.generate", label: "初始将领生成", attempt: 1, status: "completed", points: { input: 5, output: 19, total: 24, source: "model-response" }, remainingPoints: "1876", completedAt: Date.now() }], mapFacts, serverNow: Date.now(), program: { source: "card-package", digest: "fixture-card-loaded" }, programHtml });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').classList.contains('hidden')`), true, "background updates unexpectedly navigated away from the library");
      onlineWorldFixture = await evaluate(`onlineWorldState`);
      onlineWorldFixture.world.generals.g1.experience = 24.659;
      onlineWorldFixture.world.generals.g1.cultivationCount = 0;
      await evaluate(`document.querySelector('#online-world-open-form').requestSubmit()`);
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#online-world-frame').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`document.querySelector('#online-world-profile').disabled`), true);
      fs.writeFileSync(path.join(outputDir, "online-world-game.png"), (await window.webContents.capturePage()).toPNG());
      const embeddedGameFrame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith("blob:"));
      assert(embeddedGameFrame, "missing sandboxed online-world frame");
      for (let attempt = 0; attempt < 20 && await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-command-toggle').classList.contains('hidden')`); attempt += 1) await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-command-toggle').classList.contains('hidden')`), false);
      await embeddedGameFrame.executeJavaScript(`openGeneral('g1')`);
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#general-experience').textContent`), "24.659 / 100");
      assert.equal(await embeddedGameFrame.executeJavaScript(`getComputedStyle(document.querySelector('#training-preview')).display`), "none");
      fs.writeFileSync(path.join(outputDir, "general-experience.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#close-general').click()`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-social').getAttribute('aria-expanded')`), "false");
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#social-sidebar').inert`), true);
      window.webContents.send("qa:onOnlineWorldState", { ...onlineWorldFixture, status: "ready", program: { source: "work-description", digest: "fixture-description" } });
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-open-server').disabled`), true);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#connection-notice').classList.contains('hidden')`), true);
      window.webContents.send("qa:onOnlineWorldState", { ...onlineWorldFixture, status: "degraded", syncing: false });
      await settle();
      await evaluate(`document.querySelector('#official-notice-action').click()`);
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#connection-notice').classList.contains('hidden')`), false);
      const retryLayout = await embeddedGameFrame.executeJavaScript(`(() => {
        const tip=document.querySelector('#connection-notice').getBoundingClientRect();
        const button=document.querySelector('#connection-retry'); const rect=button.getBoundingClientRect();
        return {text:button.textContent, fits:rect.right<=tip.right&&rect.bottom<=tip.bottom, width:rect.width, height:rect.height};
      })()`);
      assert.equal(retryLayout.text, "重试");
      assert.equal(retryLayout.fits, true);
      assert(retryLayout.width <= 80 && retryLayout.height <= 32, "retry action should stay compact");
      fs.writeFileSync(path.join(outputDir, "connection-retry.png"), (await window.webContents.capturePage()).toPNG());
      assert.equal(await embeddedGameFrame.executeJavaScript(`(() => {
        document.querySelector('#connection-retry').click();
        return document.querySelector('#connection-retry').textContent;
      })()`), "重试中");
      await settle();
      assert.equal(calls.filter(call => call.name === "syncOnlineWorld").length, 1, "retry did not reach the host");
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#connection-notice').classList.contains('hidden')`), true);
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-command-toggle').click()`);
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-publish-program')`), null);
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#close-owner-command').click()`);
      window.webContents.send("qa:onOnlineWorldState", { ...onlineWorldFixture, syncing: true, revision: 99, isAuthor: false, isServerOwner: false });
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#owner-command-toggle').classList.contains('hidden')`), true);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#connection-notice').classList.contains('hidden')`), true);
      window.webContents.send("qa:onOnlineWorldState", onlineWorldFixture);
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#points-balance-value').textContent`), "1,876");
      const soundControlQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const knob=document.querySelector('#sound-knob'); const inner=knob.querySelector('i');
        const outerRect=knob.getBoundingClientRect(); const innerRect=inner.getBoundingClientRect();
        setSoundVolume(60,{persist:false});
        knob.dispatchEvent(new PointerEvent('pointerdown',{pointerId:31,clientX:outerRect.left+12,clientY:outerRect.top+12,bubbles:true}));
        knob.dispatchEvent(new PointerEvent('pointermove',{pointerId:31,clientX:outerRect.right-1,clientY:outerRect.bottom-1,bubbles:true}));
        knob.dispatchEvent(new PointerEvent('pointerup',{pointerId:31,clientX:outerRect.right-1,clientY:outerRect.bottom-1,bubbles:true}));
        return {outer:[outerRect.width,outerRect.height],inner:[innerRect.width,innerRect.height],percent:document.querySelector('#sound-volume-label').textContent,value:knob.getAttribute('aria-valuenow')};
      })()`);
      assert.deepEqual(soundControlQa.outer, [24, 24]);
      assert(soundControlQa.inner[0] >= 14 && soundControlQa.inner[1] >= 14, `sound knob inner disc collapsed: ${JSON.stringify(soundControlQa)}`);
      assert.equal(soundControlQa.percent, '音效 100%', 'dragging the sound knob did not reach full volume');
      assert.equal(soundControlQa.value, '100');
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`audioContext?.state`), "running", "game audio context did not unlock after a pointer gesture");
      const soundClickQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const knob=document.querySelector('#sound-knob'); suppressSoundKnobClick=false;
        setSoundVolume(90,{persist:false}); knob.click(); const first=knob.getAttribute('aria-valuenow');
        knob.click(); const second=knob.getAttribute('aria-valuenow');
        knob.click(); const third=knob.getAttribute('aria-valuenow');
        return [first,second,third];
      })()`);
      assert.deepEqual(soundClickQa, ['100','0','10'], 'sound knob click should add ten percent and wrap after 100');
      const preferencesClickQa = await embeddedGameFrame.executeJavaScript(`(() => {
        document.querySelector('#edit-preferences').click();
        document.querySelector('#preference-tag-options button').click();
        document.querySelector('input[name="preference-orientation"][value="women"]').click();
        const button = document.querySelector('#save-preferences');
        button.click();
        return {
          type: button.type,
          disabled: button.disabled,
          text: button.textContent,
          status: document.querySelector('#preferences-save-status').textContent,
          modalVisible: !document.querySelector('#preferences-modal').classList.contains('hidden')
        };
      })()`);
      assert.deepEqual(preferencesClickQa, { type: 'button', disabled: true, text: '保存中…', status: '正在保存…', modalVisible: true });
      await settle();
      const preferenceCall = calls.filter(call => call.name === 'updateOnlineWorldPreferences').at(-1);
      assert(preferenceCall, 'preference save button did not dispatch to the desktop host');
      assert.equal(preferenceCall.args[0]?.orientation, 'women');
      assert.equal(preferenceCall.args[0]?.characterTags?.length, 1);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#preferences-modal').classList.contains('hidden')`), true, 'preference modal did not close after a successful save');
      if (process.env.FYMP_QA_PREFERENCES_ONLY === "1") {
        assert.deepEqual(errors, []);
        console.log("Preference save integration QA passed");
        window.destroy();
        app.exit(0);
        return;
      }
      const ordinaryButtonSoundQa = await embeddedGameFrame.executeJavaScript(`(() => {
        setSoundVolume(60,{persist:false});
        const original=audioTone; const tones=[];
        audioTone=(context,frequency,...rest)=>{tones.push(frequency);};
        document.querySelector('#center-player').dispatchEvent(new PointerEvent('pointerdown',{pointerId:44,bubbles:true}));
        audioTone=original;
        return tones;
      })()`);
      assert.deepEqual(ordinaryButtonSoundQa, [430], 'ordinary button pointerdown did not schedule its click sound');
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#model-usage-log').textContent.includes('−24 积分')`), true);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#model-usage-log').textContent.includes('剩余 1,876')`), true);
      assert.equal(await embeddedGameFrame.executeJavaScript(`getComputedStyle(document.querySelector('#general-profile-name')).fontSize`), '15px');
      assert.equal(await embeddedGameFrame.executeJavaScript(`getComputedStyle(document.querySelector('#general-core-setting')).fontSize`), '13px');
      const marketUi = await embeddedGameFrame.executeJavaScript(`(() => {
        document.querySelector('#market-open').click();
        const entry = document.querySelector('#market-open').textContent;
        const countLabel = document.querySelector('#market-total-label').textContent;
        document.querySelector('#market-sell-open').click();
        const select = document.querySelector('#market-sell-general');
        const options = [...select.options].map(option => ({ value: option.value, disabled: option.disabled }));
        document.querySelector('#market-sell-price').value = '1234';
        document.querySelector('#market-sell-note').value = '善守城，愿寻识才之主。';
        document.querySelector('#market-sell-submit').click();
        return { entry, countLabel, options, sheetClosed: document.querySelector('#market-sell-sheet').classList.contains('hidden') };
      })()`);
      assert(marketUi.entry.includes('在售数量'), 'market entry is missing the listing count label');
      assert.equal(marketUi.countLabel, '当前在售 0 名');
      assert(marketUi.options.some(option => option.value === 'g1' && !option.disabled), 'market sell dialog did not offer a carried general');
      assert.equal(marketUi.sheetClosed, true, `market sell dialog did not close after dispatch: ${JSON.stringify(marketUi)}`);
      await settle();
      assert(calls.some(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'list-general' && call.args[0]?.sellerIntro === '善守城，愿寻识才之主。'), `market listing did not carry seller introduction: ${JSON.stringify(calls.filter(call => call.name === 'submitOnlineWorldIntent').slice(-3))}`);
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#market-close').click()`);
      const dialogueClick = await embeddedGameFrame.executeJavaScript(`(() => {
        window.__dialogueClickErrors = [];
        window.addEventListener('error', event => window.__dialogueClickErrors.push(event.message));
        document.querySelector('#carried-generals button.primary').click();
        const input = document.querySelector('#dialogue-input');
        input.value = '你好';
        document.querySelector('#dialogue-send').click();
        return { input: input.value, history: document.querySelector('#dialogue-history').textContent, errors: window.__dialogueClickErrors, dialogueRequests: dialogueRequests.size };
      })()`);
      assert.deepEqual(dialogueClick.errors, []);
      assert.equal(dialogueClick.input, '', 'general dialogue send button did not clear the draft');
      assert(dialogueClick.history.includes('你好'), 'general dialogue send button did not show the outgoing message');
      assert(!dialogueClick.history.includes('本地测试：你好'), 'general dialogue still prefixes the outgoing user name');
      assert.equal(dialogueClick.dialogueRequests, 1, 'general dialogue send button did not dispatch a request');
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-social').getAttribute('aria-expanded')`), "true");
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#social-sidebar').inert`), false);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#dialogue-send').textContent.trim()`), "");
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#dialogue-send svg')!==null`), true);
      assert.equal(await embeddedGameFrame.executeJavaScript(`(()=>{const item=document.querySelector('#dialogue-history p.dialogue-pending, #dialogue-history p.dialogue-failed');return item&&getComputedStyle(item).fontSize})()`), '12px');
      await settle();
      assert(calls.some(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'talk-general' && call.args[0]?.topic === '你好'), 'general dialogue request did not reach the host');
      const replyFontSize = await embeddedGameFrame.executeJavaScript(`(() => {
        allGenerals().g1.interactionHistory.push({ year: 1, accountId: 'a', userText: '你好', reply: '主公安好，我在此待命。' });
        renderDialogue();
        return getComputedStyle(document.querySelector('#dialogue-history p:not(.user):not(.dialogue-pending):not(.dialogue-failed)')).fontSize;
      })()`);
      assert.equal(replyFontSize, '14px', 'general dialogue reply remains too small');
      const borders = await embeddedGameFrame.executeJavaScript(`Array.from(document.querySelectorAll('#dialogue-history p')).map(item=>{const css=getComputedStyle(item);return[css.borderLeftWidth,css.borderRightWidth]})`);
      assert(borders.every(([left, right]) => left === right), "chat still has a decorative left stripe");
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-social').click()`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-social').getAttribute('aria-expanded')`), "false");
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#social-sidebar').inert`), true);
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#carried-generals button.primary').click()`);
      await settle();
      fs.writeFileSync(path.join(outputDir, "general-chat-drawer.png"), (await window.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(outputDir, "online-world-game.png"), (await window.webContents.capturePage()).toPNG());
      let mapMetrics;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        mapMetrics = await embeddedGameFrame.executeJavaScript(`(()=>{const viewport=document.querySelector('#map-viewport');const canvas=document.querySelector('#map');return{label:document.querySelector('#zoom-label').textContent,visibleColumns:viewport.clientWidth/(canvas.getBoundingClientRect().width/64)}})()`);
        if (mapMetrics.visibleColumns >= 11 && mapMetrics.visibleColumns <= 13) break;
        await settle();
      }
      assert.equal(mapMetrics.label, "1×");
      assert(mapMetrics.visibleColumns >= 11 && mapMetrics.visibleColumns <= 13);
      const selectedPowerQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const value=document.querySelector('#cell-power'); const previous=value.textContent;
        value.textContent='123,456'; const range=document.createRange(); range.selectNodeContents(value);
        const style=getComputedStyle(value); const crest=value.closest('.power-crest');
        const result={lineRects:range.getClientRects().length,whiteSpace:style.whiteSpace,fontSize:parseFloat(style.fontSize),fits:crest.scrollWidth<=crest.clientWidth};
        value.textContent=previous; return result;
      })()`);
      assert.equal(selectedPowerQa.lineRects, 1, '选中区域的五位以上守备战力发生换行');
      assert.equal(selectedPowerQa.whiteSpace, 'nowrap');
      assert(selectedPowerQa.fontSize >= 20, '守备战力为了避免换行被缩得过小');
      assert.equal(selectedPowerQa.fits, true, '选中区域的五位以上守备战力横向溢出');
      const zoomed = await embeddedGameFrame.executeJavaScript(`(()=>{const viewport=document.querySelector('#map-viewport');viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));return document.querySelector('#zoom-label').textContent})()`);
      assert.equal(zoomed, "1.25×");
      const panned = await embeddedGameFrame.executeJavaScript(`(()=>{const viewport=document.querySelector('#map-viewport');viewport.scrollTo(1000,1000);viewport.setPointerCapture=()=>{};viewport.hasPointerCapture=()=>false;viewport.dispatchEvent(new PointerEvent('pointerdown',{button:2,pointerId:7,clientX:500,clientY:500,bubbles:true}));viewport.dispatchEvent(new PointerEvent('pointermove',{button:2,buttons:2,pointerId:7,clientX:400,clientY:420,bubbles:true}));viewport.dispatchEvent(new PointerEvent('pointerup',{button:2,pointerId:7,clientX:400,clientY:420,bubbles:true}));return viewport.scrollLeft>1000&&viewport.scrollTop>1000})()`);
      assert.equal(panned, true);
      await embeddedGameFrame.executeJavaScript(`(() => {
        document.querySelector('#dialogue-modal').classList.add('hidden');
        document.querySelector('#general-modal').classList.add('hidden');
        const now = hostTime();
        payload.world.jobs = {
          mining: { id:'mining', type:'mining', accountId:'a', x:4, y:7, auto:false, startedAt:now, lastSettledAt:now, finishAt:now+600000, cycleMs:600000, yieldPerCycle:125 },
          training: { id:'training', type:'training', accountId:'a', x:4, y:7, amount:40, finishAt:now+120000 },
          marching: { id:'marching', type:'march', accountId:'a', from:{x:4,y:7}, to:{x:10,y:10}, finishAt:now+540000, soldiers:30, generalIds:['g1'] }
        };
        selected = {x:10,y:10};
        setZoom(1);
        renderJobs();
        draw();
      })()`);
      await settle();
      await embeddedGameFrame.executeJavaScript(`centerMap({x:7,y:8}, 'instant')`);
      await settle();
      const hoverTask = async (x, y) => embeddedGameFrame.executeJavaScript(`(() => {
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + canvas.clientLeft + ${x} * canvas.clientWidth / 64;
        const clientY = rect.top + canvas.clientTop + ${y} * canvas.clientHeight / 64;
        canvas.dispatchEvent(new PointerEvent('pointermove', {clientX, clientY, bubbles:true}));
        const tip = document.querySelector('#map-task-tooltip');
        return {text:tip.textContent, hidden:tip.classList.contains('hidden'), left:tip.getBoundingClientRect().left, right:tip.getBoundingClientRect().right, width:innerWidth};
      })()`);
      const mineTip = await hoverTask(4.2, 7.2);
      assert.equal(mineTip.hidden, false);
      assert(mineTip.text.includes("开采资源") && mineTip.text.includes("125 金币") && mineTip.text.includes("本轮剩余"));
      assert(mineTip.left >= 0 && mineTip.right <= mineTip.width);
      await settle();
      fs.writeFileSync(path.join(outputDir, "map-task-mining.png"), (await window.webContents.capturePage()).toPNG());
      const trainingTip = await hoverTask(4.8, 7.2);
      assert.equal(trainingTip.hidden, false);
      assert(trainingTip.text.includes("练兵") && trainingTip.text.includes("预计新增：30 士兵")
        && trainingTip.text.includes("计划 40 人") && trainingTip.text.includes("剩余"));
      await settle();
      fs.writeFileSync(path.join(outputDir, "map-task-training.png"), (await window.webContents.capturePage()).toPNG());
      const marchTip = await hoverTask(8, 8.5);
      assert.equal(marchTip.hidden, false);
      assert(marchTip.text.includes("起点 (4, 7) → 目标 (10, 10)") && marchTip.text.includes("剩余"));
      const activeMarchUiQa = await embeddedGameFrame.executeJavaScript(`(() => {
        renderCell();
        return {
          count:document.querySelector('#current-march-army').textContent,
          transferHidden:document.querySelector('#map-army-transfer').classList.contains('hidden')
        };
      })()`);
      assert.deepEqual(activeMarchUiQa, { count:'行军队伍 30 人', transferHidden:true }, '在途兵力或行军期间的调兵面板状态错误');
      await settle();
      fs.writeFileSync(path.join(outputDir, "map-task-march.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`delete payload.world.jobs.marching; payload.world.players.a.fieldArmySoldiers=30; payload.world.players.a.gold=1000; marchQuoteCache=null; draw()`);
      const previewTip = await hoverTask(8, 8.5);
      assert(previewTip.text.includes("行军路线预览") && previewTip.text.includes("预计耗时：2分15秒"), JSON.stringify(previewTip));
      assert(!previewTip.text.includes("预计消耗") && !previewTip.text.includes("金币不足"));
      const layoutQa = await embeddedGameFrame.executeJavaScript(`(() => {
        renderCell(); switchSocialTab('world');
        const area = document.querySelector('#selected-area').getBoundingClientRect();
        const map = document.querySelector('.map-card').getBoundingClientRect();
        const actions = document.querySelector('#map-region-actions').getBoundingClientRect();
        const transfer = document.querySelector('#map-army-transfer').getBoundingClientRect();
        const sidebar = document.querySelector('aside').getBoundingClientRect();
        return {
          width:area.width,
          mapWidth:map.width,
          top:area.top,
          mapBottom:map.bottom,
          right:area.right,
          sidebarLeft:sidebar.left,
          title:document.querySelector('#selected-area').textContent,
          returnTop:document.querySelector('#return-library').getBoundingClientRect().top,
          actionsHidden:document.querySelector('#map-region-actions').classList.contains('hidden'),
          territoryHidden:document.querySelector('#territory-actions').classList.contains('hidden'),
          actionsLeft:actions.left,
          actionsTop:actions.top,
          mapLeft:map.left,
          mapTop:map.top,
          mapRight:map.right,
          transferHidden:document.querySelector('#map-army-transfer').classList.contains('hidden'),
          transferTop:transfer.top,
          transferRight:transfer.right,
          transferParent:document.querySelector('#map-army-transfer').parentElement.className,
          transferContainer:document.querySelector('#map-army-transfer').closest('.map-card')?.className || '',
          currentMarchArmy:document.querySelector('#current-march-army').textContent,
          floatingParty:document.querySelector('#march-party-panel')
        };
      })()`);
      assert(Math.abs(layoutQa.width - layoutQa.mapWidth) < 2 && layoutQa.top > layoutQa.mapBottom && layoutQa.right < layoutQa.sidebarLeft);
      assert(layoutQa.title.includes("选中的区域") && layoutQa.returnTop < 50);
      assert.equal(layoutQa.actionsHidden, false);
      assert.equal(layoutQa.territoryHidden, true);
      assert.equal(layoutQa.floatingParty, null, '地图右上角仍存在行军队伍面板');
      assert(Math.abs(layoutQa.actionsLeft - layoutQa.mapLeft) < 6 && Math.abs(layoutQa.actionsTop - layoutQa.mapTop) < 6);
      assert.equal(layoutQa.transferHidden, false, '玩家位于自己的领地时没有显示驻军调度面板');
      assert.equal(layoutQa.transferParent, 'map-corner-shell map-corner-shell-right', '驻军调度面板缺少右上角收起外壳');
      assert.equal(layoutQa.transferContainer, 'map-card', '驻军调度面板不在地图容器内');
      assert(Math.abs(layoutQa.transferRight - layoutQa.mapRight) < 6 && Math.abs(layoutQa.transferTop - layoutQa.mapTop) < 6, `驻军调度面板没有固定在地图右上角：${JSON.stringify(layoutQa)}`);
      assert.equal(layoutQa.currentMarchArmy, '行军队伍 30 人');
      const foreignPositionTransferQa = await embeddedGameFrame.executeJavaScript(`(() => {
        payload.world.players.a.position={x:5,y:7}; renderCell();
        const hidden=document.querySelector('#map-army-transfer').classList.contains('hidden');
        payload.world.players.a.position={x:4,y:7}; renderCell();
        return hidden;
      })()`);
      assert.equal(foreignPositionTransferQa, true, '玩家位于他人领地时仍显示驻军调度面板');
      const marchDialogQa = await embeddedGameFrame.executeJavaScript(`(() => {
        document.querySelector('#march').click();
        marchQuoteCache={requestKey:marchQuoteKey(),cost:90,durationMs:270000}; renderMarchConfirmation();
        const slot=document.querySelector('#march-army-transfer-slot');
        const transfer=document.querySelector('#map-army-transfer');
        return {
          visible:!document.querySelector('#march-confirmation').classList.contains('hidden'),
          route:document.querySelector('#march-confirmation-route').textContent,
          count:document.querySelector('#march-party-count').textContent,
          cost:document.querySelector('#march-party-cost').textContent,
          transferInDialog:document.querySelector('#march-confirmation #army-transfer-amount') !== null,
          transferHidden:transfer.classList.contains('hidden'),
          transferParent:transfer.parentElement.id,
          slotHidden:slot.classList.contains('hidden'),
          slotAriaHidden:slot.getAttribute('aria-hidden'),
          submitDisabled:document.querySelector('#march-confirmation-submit').disabled
        };
      })()`);
      assert.deepEqual(marchDialogQa, { visible:true, route:'(4, 7) → (10, 10) · 9 格', count:'30 人', cost:'90 金币', transferInDialog:true, transferHidden:false, transferParent:'march-army-transfer-slot', slotHidden:false, slotAriaHidden:'false', submitDisabled:false });
      fs.writeFileSync(path.join(outputDir, "march-confirmation.png"), (await window.webContents.capturePage()).toPNG());
      const foreignMarchDialogQa = await embeddedGameFrame.executeJavaScript(`(() => {
        payload.world.players.a.position={x:5,y:7}; renderCell(); renderMarchConfirmation();
        const slot=document.querySelector('#march-army-transfer-slot');
        const transfer=document.querySelector('#map-army-transfer');
        const foreign={
          transferHidden:transfer.classList.contains('hidden'),
          transferInDialog:document.querySelector('#march-confirmation #army-transfer-amount') !== null,
          slotHidden:slot.classList.contains('hidden'),
          slotAriaHidden:slot.getAttribute('aria-hidden')
        };
        payload.world.players.a.position={x:4,y:7};
        marchQuoteCache={requestKey:marchQuoteKey(),cost:90,durationMs:270000};
        renderCell(); renderMarchConfirmation();
        return foreign;
      })()`);
      assert.deepEqual(foreignMarchDialogQa, { transferHidden:true, transferInDialog:false, slotHidden:true, slotAriaHidden:'true' }, '玩家脚下不是自有领地时，行军弹窗仍显示驻军调度');
      const restoredMapTransferQa = await embeddedGameFrame.executeJavaScript(`(() => {
        closeMarchConfirmation();
        const slot=document.querySelector('#march-army-transfer-slot');
        const transfer=document.querySelector('#map-army-transfer');
        const restored={
          dialogHidden:document.querySelector('#march-confirmation').classList.contains('hidden'),
          transferHidden:transfer.classList.contains('hidden'),
          transferParent:transfer.parentElement.className,
          slotHidden:slot.classList.contains('hidden')
        };
        document.querySelector('#march').click();
        marchQuoteCache={requestKey:marchQuoteKey(),cost:90,durationMs:270000}; renderMarchConfirmation();
        return restored;
      })()`);
      assert.deepEqual(restoredMapTransferQa, { dialogHidden:true, transferHidden:false, transferParent:'map-corner-shell map-corner-shell-right', slotHidden:true }, '关闭行军弹窗后驻军调度没有回到地图右上角');
      const quoteFailureQa = await embeddedGameFrame.executeJavaScript(`(() => {
        marchQuoteFailureKey=marchQuoteKey(); marchQuoteCache=null; renderMarchConfirmation();
        const failed={retryVisible:!document.querySelector('#march-quote-retry').classList.contains('hidden'),submitDisabled:document.querySelector('#march-confirmation-submit').disabled,note:document.querySelector('#march-confirmation-note').textContent};
        document.querySelector('#march-quote-retry').click(); clearTimeout(marchQuoteTimer);
        return {...failed,retryCleared:marchQuoteFailureKey==='' };
      })()`);
      assert.equal(quoteFailureQa.retryVisible, true);
      assert.equal(quoteFailureQa.submitDisabled, true);
      assert(quoteFailureQa.note.includes('重新核算'));
      assert.equal(quoteFailureQa.retryCleared, true);
      const transferPendingQa = await embeddedGameFrame.executeJavaScript(`(() => {
        marchQuoteCache={requestKey:marchQuoteKey(),cost:90,durationMs:270000};
        pendingHostKeys.set('intent:gather-march','qa-transfer'); renderCell(); renderMarchConfirmation();
        const value={submitDisabled:document.querySelector('#march-confirmation-submit').disabled,inputDisabled:document.querySelector('#army-transfer-amount').disabled,panelHidden:document.querySelector('#map-army-transfer').classList.contains('hidden'),note:document.querySelector('#march-confirmation-note').textContent};
        pendingHostKeys.delete('intent:gather-march'); renderCell(); renderMarchConfirmation(); return value;
      })()`);
      assert.deepEqual(transferPendingQa, { submitDisabled:true, inputDisabled:true, panelHidden:false, note:'正在同步调兵结果，请稍候。' });
      const transferCallsBefore = calls.filter(call => call.name === 'submitOnlineWorldIntent' && ['gather-march','deploy-soldiers'].includes(call.args[0]?.type)).length;
      const negativeTransferQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const input=document.querySelector('#army-transfer-amount');
        input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));
        const emptyValue=input.value;
        input.value='-17'; input.dispatchEvent(new Event('input',{bubbles:true}));
        const confirm=document.querySelector('#army-transfer-confirm');
        return {emptyValue,value:input.value,draft:armyTransferDraft,confirmDisabled:confirm.disabled,awaiting:confirm.classList.contains('awaiting-confirmation'),hintHidden:document.querySelector('#army-transfer-confirm-hint').classList.contains('hidden')};
      })()`);
      assert.deepEqual(negativeTransferQa, { emptyValue:'', value:'-17', draft:-17, confirmDisabled:false, awaiting:true, hintHidden:false });
      assert.equal(calls.filter(call => call.name === 'submitOnlineWorldIntent' && ['gather-march','deploy-soldiers'].includes(call.args[0]?.type)).length, transferCallsBefore, '输入调兵数字时不应立即生效');
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#army-transfer-confirm').click()`);
      await settle();
      assert(calls.some(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'deploy-soldiers' && call.args[0]?.amount === 17), '确认负数调兵后未提交部署行动');
      const marchCallsBefore = calls.filter(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'march').length;
      await embeddedGameFrame.executeJavaScript(`payload.world.players.a.gold = 0; payload.world.players.a.fieldArmySoldiers = 30; marchQuoteCache={requestKey:marchQuoteKey(),cost:90,durationMs:270000}; renderMarchConfirmation()`);
      await settle();
      assert.equal(calls.filter(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'march').length, marchCallsBefore);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#march-confirmation-note').textContent.includes('金币不足')`), true);
      await embeddedGameFrame.executeJavaScript(`payload.world.players.a.gold = 1000; marchQuoteCache={requestKey:marchQuoteKey(),cost:90,durationMs:270000}; renderMarchConfirmation(); document.querySelector('#march-confirmation-submit').click()`);
      await settle();
      assert(calls.some(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'march' && call.args[0]?.soldiers === 30 && call.args[0]?.to?.x === 10 && call.args[0]?.to?.y === 10), '确认弹窗未提交行军行动');
      const marchPendingLockQa = await embeddedGameFrame.executeJavaScript(`(() => ({
        closeResult:closeMarchConfirmation(),
        dialogVisible:!document.querySelector('#march-confirmation').classList.contains('hidden'),
        closeDisabled:document.querySelector('#march-confirmation-close').disabled,
        cancelDisabled:document.querySelector('#march-confirmation-cancel').disabled,
        transferLocked:document.querySelector('#map-army-transfer').inert,
        busy:document.querySelector('#march-confirmation').getAttribute('aria-busy'),
        note:document.querySelector('#march-confirmation-note').textContent
      }))()`);
      assert.deepEqual(marchPendingLockQa, { closeResult:false, dialogVisible:true, closeDisabled:true, cancelDisabled:true, transferLocked:true, busy:'true', note:'正在处理行军，请勿重复操作。' }, '行军处理中弹窗仍可提前关闭或重复调兵');
      await embeddedGameFrame.executeJavaScript(`for (const [requestId, request] of pendingHostRequests) if (request.key === 'intent:march') finishHostRequest(requestId); marchSubmitting=false; closeMarchConfirmation({force:true})`);
      const zeroArmyCallsBefore = calls.filter(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'march').length;
      const zeroArmyConfirmQa = await embeddedGameFrame.executeJavaScript(`(() => {
        for (const [requestId, request] of pendingHostRequests) if (request.key === 'intent:march') finishHostRequest(requestId);
        marchSubmitting=false; payload.world.players.a.fieldArmySoldiers=0; selected={x:10,y:10}; openMarchConfirmation();
        marchQuoteCache={requestKey:marchQuoteKey(),cost:63,durationMs:270000}; renderMarchConfirmation();
        document.querySelector('#march-confirmation-submit').click();
        return {
          visible:!document.querySelector('#zero-army-march-confirmation').classList.contains('hidden'),
          text:document.querySelector('#zero-army-march-confirmation').textContent,
          mainVisible:!document.querySelector('#march-confirmation').classList.contains('hidden')
        };
      })()`);
      assert.equal(zeroArmyConfirmQa.visible, true, '零兵行军没有出现二次确认');
      assert.equal(zeroArmyConfirmQa.mainVisible, true);
      assert(zeroArmyConfirmQa.text.includes('您目前行军队伍中没有士兵，是否开始行军？'));
      assert.equal(calls.filter(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'march').length, zeroArmyCallsBefore, '零兵二次确认前已经提交行军');
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#zero-army-march-confirm').click()`);
      await settle();
      const zeroArmyMarchCalls = calls.filter(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'march').slice(zeroArmyCallsBefore);
      assert(zeroArmyMarchCalls.some(call => call.args[0]?.soldiers === 0 && call.args[0]?.to?.x === 10 && call.args[0]?.to?.y === 10), '确认后没有提交零兵行军');
      await embeddedGameFrame.executeJavaScript(`for (const [requestId, request] of pendingHostRequests) if (request.key === 'intent:march') finishHostRequest(requestId); marchSubmitting=false; closeMarchConfirmation({force:true}); payload.world.players.a.fieldArmySoldiers=30; selected={x:10,y:10}; renderCell()`);
      const neutralUnderfootQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const owned=payload.world.cells['4,7']; delete payload.world.cells['4,7']; selected={x:4,y:7}; openMarchConfirmation();
        marchQuoteCache={revision:payload.world.revision,requestKey:marchQuoteKey(),path:[],cost:0,durationMs:0}; renderMarchConfirmation();
        const value={attackHidden:document.querySelector('#march-attack-field').classList.contains('hidden'),cost:document.querySelector('#march-party-cost').textContent,duration:document.querySelector('#march-party-duration').textContent,submitText:document.querySelector('#march-confirmation-submit').textContent,submitDisabled:document.querySelector('#march-confirmation-submit').disabled};
        closeMarchConfirmation(); payload.world.cells['4,7']=owned; selected={x:10,y:10}; renderCell(); return value;
      })()`);
      assert.deepEqual(neutralUnderfootQa, { attackHidden:true, cost:'0 金币', duration:'立即结算', submitText:'确认攻打', submitDisabled:false });
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-selected-area').click()`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-selected-area').getAttribute('aria-expanded')`), "false");
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#toggle-selected-area').click(); confirmDeploy('g1')`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#deploy-confirmation-text').textContent`), "目前区域尚未占领，请行军至已占领领土部署。");
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#deploy-cancel').click(); selected={x:4,y:7}; confirmDeploy('g1')`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#deploy-confirmation-text').textContent`), "是否将青禾部署到此处？");
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#deploy-cancel').click(); payload.worldChat=[{messageId:'qa-chat',accountId:'b',displayName:'北境玩家',text:'共守边疆',createdAt:Date.now()}];renderWorldChat()`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#world-chat-messages').textContent.includes('共守边疆')`), true);
      const worldChatClick = await embeddedGameFrame.executeJavaScript(`(() => {
        const input = document.querySelector('#world-chat-input');
        input.value = '世界测试';
        document.querySelector('#world-chat-send').click();
        return { value: input.value, pending: document.querySelector('#world-chat-send').disabled };
      })()`);
      assert.equal(worldChatClick.value, '', `world chat send button did not clear the draft: ${JSON.stringify(worldChatClick)}`);
      assert.equal(worldChatClick.pending, true, 'world chat send button did not enter pending state');
      await settle();
      assert(calls.some(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'world-chat' && call.args[0]?.text === '世界测试'), 'world chat send button did not reach the host');
      assert.equal(await embeddedGameFrame.executeJavaScript(`getComputedStyle(document.querySelector('#map-viewport')).scrollbarWidth`), 'none', 'map scrollbar rail is still visible');
      const lettersQa = await embeddedGameFrame.executeJavaScript(`(() => {
        payload.directInbox = [];
        payload.directHistory = [
          { messageId:'qa-in-letter', fromAccountId:'b', createdAt:Date.now(), payload:{ generalName:'青禾', purpose:'报平安', text:'边境已经安稳。' } },
          { messageId:'qa-out-letter', direction:'out', toAccountId:'b', createdAt:Date.now(), payload:{ generalName:'青禾', text:'请继续留意北境。' } }
        ];
        renderInbox();
        const received = document.querySelector('#direct-inbox');
        const sent = document.querySelector('#direct-outbox');
        const before = document.querySelector('#letter-detail-modal').classList.contains('hidden');
        received.firstElementChild.click();
        updateCommunicationNotifications(payload, false);
        for (const category of Object.keys(communicationSeen)) communicationSeen[category] = new Set(communicationSnapshot(payload)[category]);
        communicationUnread.world = 0; communicationUnread.generals = 0; communicationUnread.letters = 0; renderCommunicationBadges();
        return { total:document.querySelector('#direct-count').textContent, received:received.children.length, sent:sent.children.length, before, title:document.querySelector('#letter-detail-title').textContent, text:document.querySelector('#letter-detail-text').textContent };
      })()`);
      assert.deepEqual(lettersQa, { total:'2', received:1, sent:1, before:true, title:'报平安', text:'边境已经安稳。' });
      fs.writeFileSync(path.join(outputDir, "letters-detail.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#letter-detail-close').click(); setSocialOpen(false); applyHostedState({...payload, worldChat:[...payload.worldChat,{messageId:'qa-chat-new',accountId:'b',displayName:'北境玩家',text:'新的边境消息',createdAt:Date.now()}], directInbox:[...payload.directInbox,{messageId:'qa-inbox-new',fromAccountId:'b',payload:{generalName:'青禾',text:'又有一封信。'},createdAt:Date.now()}], serverNow:Date.now()}, true); renderCommunicationBadges()`);
      const unreadQa = await embeddedGameFrame.executeJavaScript(`({ dock:document.querySelector('#social-unread-badge').textContent, world:document.querySelector('[data-social-badge="world"]').textContent, letters:document.querySelector('[data-social-badge="letters"]').textContent })`);
      assert.deepEqual(unreadQa, { dock:'2', world:'1', letters:'1' });
      await embeddedGameFrame.executeJavaScript(`setSocialOpen(true); switchSocialTab('letters')`);
      await settle();
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('[data-social-badge="letters"]').classList.contains('hidden')`), true);
      fs.writeFileSync(path.join(outputDir, "letters-pane.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`switchSocialTab('world')`);
      fs.writeFileSync(path.join(outputDir, "world-chat-selected-area.png"), (await window.webContents.capturePage()).toPNG());
      const ownTerritoryActions = await embeddedGameFrame.executeJavaScript(`(() => {
        selected={x:4,y:7};
        delete payload.world.jobs.training; delete payload.world.jobs.mining;
        renderCell();
        return {
          actionsHidden:document.querySelector('#map-region-actions').classList.contains('hidden'),
          territoryHidden:document.querySelector('#territory-actions').classList.contains('hidden'),
          text:document.querySelector('#map-region-actions').textContent
        };
      })()`);
      assert.equal(ownTerritoryActions.actionsHidden, false);
      assert.equal(ownTerritoryActions.territoryHidden, false);
      assert(ownTerritoryActions.text.includes("开采资源") && ownTerritoryActions.text.includes("开始练兵"));
      const miningCooldownQa = await embeddedGameFrame.executeJavaScript(`(() => {
        payload.world.privatePlayers ||= {};
        payload.world.privatePlayers.a ||= {};
        payload.world.privatePlayers.a.miningCooldowns ||= {};
        delete payload.world.privatePlayers.a.miningCooldowns['4,7'];
        renderCell();
        const before={actionsHeight:document.querySelector('#territory-actions').getBoundingClientRect().height,buttonHeight:document.querySelector('#start-mining').getBoundingClientRect().height,text:document.querySelector('#start-mining').textContent,hintHeight:document.querySelector('#mining-cooldown').getBoundingClientRect().height};
        payload.world.privatePlayers.a.miningCooldowns['4,7']=hostTime()+65000;
        renderCell();
        const after={actionsHeight:document.querySelector('#territory-actions').getBoundingClientRect().height,buttonHeight:document.querySelector('#start-mining').getBoundingClientRect().height,text:document.querySelector('#start-mining').textContent,hint:document.querySelector('#mining-cooldown').textContent,hintHeight:document.querySelector('#mining-cooldown').getBoundingClientRect().height,disabled:document.querySelector('#start-mining').disabled};
        delete payload.world.privatePlayers.a.miningCooldowns['4,7']; renderCell();
        return {before,after};
      })()`);
      assert.equal(miningCooldownQa.before.text, '开采资源');
      assert.equal(miningCooldownQa.after.text, '开采资源');
      assert.equal(miningCooldownQa.after.disabled, true);
      assert(miningCooldownQa.after.hint.startsWith('冷却 '), `采集冷却没有显示在独立提示行：${JSON.stringify(miningCooldownQa)}`);
      assert(Math.abs(miningCooldownQa.before.actionsHeight - miningCooldownQa.after.actionsHeight) < 1, `冷却提示改变了行动区高度：${JSON.stringify(miningCooldownQa)}`);
      assert(Math.abs(miningCooldownQa.before.buttonHeight - miningCooldownQa.after.buttonHeight) < 1 && Math.abs(miningCooldownQa.before.hintHeight - miningCooldownQa.after.hintHeight) < 1, `采集按钮或冷却提示行尺寸不稳定：${JSON.stringify(miningCooldownQa)}`);
      const trainSliderQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const input = document.querySelector('#train-amount');
        payload.world.players.a.gold=1000;
        input.value = '10';
        input.dispatchEvent(new Event('input', { bubbles:true }));
        const live={value:input.value,output:document.querySelector('#train-amount-value').value,cost:document.querySelector('#train-cost').textContent,buttonDisabled:document.querySelector('#train').disabled};
        payload.world.players.a.gold=0;
        input.dispatchEvent(new Event('input', { bubbles:true }));
        const unaffordableDisabled=document.querySelector('#train').disabled;
        payload.world.players.a.gold=1000;
        input.value = input.max;
        input.dispatchEvent(new Event('input', { bubbles:true }));
        return { live, unaffordableDisabled, value:input.value, max:input.max, output:document.querySelector('#train-amount-value').value, cost:document.querySelector('#train-cost').textContent, buttonDisabled:document.querySelector('#train').disabled };
      })()`);
      assert.deepEqual(trainSliderQa.live, { value:'10', output:'10', cost:'20', buttonDisabled:false }, `练兵滑块没有实时刷新金币：${JSON.stringify(trainSliderQa)}`);
      assert.equal(trainSliderQa.unaffordableDisabled, true, `练兵金币不足时按钮仍可提交：${JSON.stringify(trainSliderQa)}`);
      assert.equal(trainSliderQa.value, trainSliderQa.max, `练兵滑块未到达上限：${JSON.stringify(trainSliderQa)}`);
      assert.equal(trainSliderQa.output, trainSliderQa.max, `练兵滑块显示值未同步：${JSON.stringify(trainSliderQa)}`);
      assert.equal(trainSliderQa.cost, String(Number(trainSliderQa.max) * 2), `练兵上限费用显示错误：${JSON.stringify(trainSliderQa)}`);
      assert.equal(trainSliderQa.buttonDisabled, false, `练兵滑块上限不可提交：${JSON.stringify(trainSliderQa)}`);
      const companionExpansion = await embeddedGameFrame.executeJavaScript(`(() => {
        document.querySelector('.area-companions').click();
        const section = document.querySelector('.area-companions');
        const list = document.querySelector('#carried-generals');
        const rect = list.getBoundingClientRect();
        return {
          expanded: section.classList.contains('companions-expanded'),
          cards: list.querySelectorAll('.general-card').length,
          active: list.querySelectorAll('.general-card.march-active').length,
          overflowY: getComputedStyle(list).overflowY,
          top: rect.top,
          bottom: rect.bottom,
          viewportHeight: innerHeight
        };
      })()`);
      assert.deepEqual({ expanded: companionExpansion.expanded, cards: companionExpansion.cards, active: companionExpansion.active, overflowY: companionExpansion.overflowY }, { expanded: true, cards: 3, active: 2, overflowY: "auto" });
      assert(companionExpansion.top >= 0 && companionExpansion.bottom <= companionExpansion.viewportHeight);
      const companionDrag = await embeddedGameFrame.executeJavaScript(`(() => {
        const list = document.querySelector('#carried-generals');
        const cards = [...list.querySelectorAll('.general-card')];
        const transfer = new DataTransfer();
        cards[2].dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:transfer}));
        const firstRect = cards[0].getBoundingClientRect();
        cards[0].dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, clientY:firstRect.top, dataTransfer:transfer}));
        const reordered = [...list.querySelectorAll('.general-card')];
        return {
          order: reordered.map(card => card.dataset.generalId),
          firstActive: reordered[0].classList.contains('march-active'),
          firstBorderStyle: getComputedStyle(reordered[0]).borderStyle,
          firstBackground: getComputedStyle(reordered[0]).backgroundColor
        };
      })()`);
      assert.deepEqual(companionDrag.order, ["g3", "g1", "g2"]);
      assert.equal(companionDrag.firstActive, true);
      assert.equal(companionDrag.firstBorderStyle, "dashed");
      assert.notEqual(companionDrag.firstBackground, "rgba(0, 0, 0, 0)");
      await settle();
      fs.writeFileSync(path.join(outputDir, "map-companion-drag.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#carried-generals').dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:new DataTransfer()}))`);
      await settle();
      const reorderCall = calls.filter(call => call.name === 'submitOnlineWorldIntent' && call.args[0]?.type === 'reorder-carried-generals').at(-1);
      assert.deepEqual(reorderCall?.args[0]?.generalIds, ["g3", "g1", "g2"]);
      await embeddedGameFrame.executeJavaScript(`document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('.area-companions').classList.contains('companions-expanded')`), false);
      await embeddedGameFrame.executeJavaScript(`setZoom(1.5)`);
      await settle();
      await embeddedGameFrame.executeJavaScript(`centerMap({x:5,y:7}, 'instant')`);
      await settle();
      assert.equal((await hoverTask(4.2, 7.2)).hidden, false, "mining hover lost alignment after zoom");
      await embeddedGameFrame.executeJavaScript(`delete payload.world.jobs.mining; draw()`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#map-task-tooltip').classList.contains('hidden')`), true, "removed task leaves a stale tooltip");
      await embeddedGameFrame.executeJavaScript(`viewport.dispatchEvent(new Event('scroll'))`);
      assert.equal(await embeddedGameFrame.executeJavaScript(`mapPointer`), null);
      const reportInitial = await embeddedGameFrame.executeJavaScript(`(() => {
        setSocialOpen(false);
        payload.world.privatePlayers ||= {};
        payload.world.privatePlayers.a ||= {};
        payload.world.privatePlayers.a.battleReports = [
          {id:'qa-attack',kind:'attack',createdAt:1000,target:{x:12,y:12},outcome:'victory',attackerPower:1600,defenderPower:500,ownLosses:20,ownSurvivors:980,soldiersGained:300,treasures:[{treasureId:'pill',materialId:'gold',amount:1}]},
          {id:'qa-loss',kind:'territory-loss',createdAt:2000,target:{x:50,y:50},outcome:'defeat',attackerPower:2400,defenderPower:1300,ownLosses:100,attackerDisplayName:'北境玩家',attackerAccountName:'north@example',capturedOwnGenerals:[{id:'qa-guard',name:'守地将领'}]}
        ];
        centerMap({x:2,y:2}, 'instant');
        renderBattleReports();
        document.querySelector('#battle-report-button').click();
        const rect = document.querySelector('.battle-report-modal').getBoundingClientRect();
        return {scroll:viewport.scrollLeft,top:rect.top,left:rect.left};
      })()`);
      await new Promise(resolve => setTimeout(resolve, 650));
      const lossQa = await embeddedGameFrame.executeJavaScript(`(() => {
        const box = document.querySelector('.battle-report-modal').getBoundingClientRect();
        const button = document.querySelector('#battle-report-prev').getBoundingClientRect();
        return {text:document.querySelector('.battle-report-modal').textContent,scroll:viewport.scrollLeft,top:box.top,left:box.left,width:button.width,height:button.height};
      })()`);
      assert(lossQa.text.includes("失地战报") && lossQa.text.includes("守地将领") && lossQa.text.includes("north@example"));
      assert(lossQa.scroll > reportInitial.scroll + 100, "opening a report did not center its map location");
      assert.equal(lossQa.top, reportInitial.top, "map movement shifted the report modal");
      assert.equal(lossQa.left, reportInitial.left);
      assert(lossQa.width >= 44 && lossQa.height >= 44);
      fs.writeFileSync(path.join(outputDir, "battle-report-loss.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#battle-report-prev').click()`);
      await new Promise(resolve => setTimeout(resolve, 650));
      const attackQa = await embeddedGameFrame.executeJavaScript(`({text:document.querySelector('.battle-report-modal').textContent,scroll:viewport.scrollLeft,index:document.querySelector('#battle-report-index').textContent})`);
      assert(attackQa.text.includes("金髓丹") && attackQa.text.includes("获得天材地宝"));
      assert(attackQa.scroll < lossQa.scroll - 100, `paging did not center the other battle: ${JSON.stringify({loss:lossQa.scroll,attack:attackQa.scroll,index:attackQa.index})}`);
      assert.equal(attackQa.index, "1 / 2");
      fs.writeFileSync(path.join(outputDir, "battle-report-treasure.png"), (await window.webContents.capturePage()).toPNG());
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#battle-report-next').click()`);
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.equal(await embeddedGameFrame.executeJavaScript(`document.querySelector('#battle-report-index').textContent`), "2 / 2");
      await embeddedGameFrame.executeJavaScript(`closeBattleReport()`);
      await embeddedGameFrame.executeJavaScript(`document.querySelector('#return-library').click()`);
      await settle();
      assert.equal(await evaluate(`!document.querySelector('#online-world-setup').classList.contains('hidden')`), true);
      assert(calls.some(call => call.name === "closeOnlineWorld"), "return to library did not pause synchronization");
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').getAttribute('src')`), "about:blank");
      const closeCallsAtLibrary = calls.filter(call => call.name === "closeOnlineWorld").length;
      window.webContents.send("qa:onOnlineWorldState", { ...onlineWorldFixture, syncing: true, revision: 100 });
      await settle();
      assert.equal(await evaluate(`document.querySelector('#online-world-title').textContent`), "游戏库");
      assert.equal(await evaluate(`document.querySelector('#online-world-frame').classList.contains('hidden')`), true);
      assert.equal(await evaluate(`/同步|修订|签名|重置并迁移/.test(document.querySelector('#online-world-setup').textContent)`), false);
      await evaluate(`renderOnlineWorldCards({cards:[...onlineWorldCards,{cardId:'other-author-game',title:'另一位作者的游戏'}]});document.querySelector('[data-card-id="other-author-game"]').click()`);
      assert.equal(await evaluate(`document.querySelector('#online-world-profile').disabled`), false, "a different game inherited the previous game's bound character");
      const foreignCardMenuQa = await evaluate(`(() => { const item=document.querySelector('[data-card-id="other-author-game"]').parentElement; return { badge:Boolean(item.querySelector('.online-world-author-badge')), remove:Boolean(item.querySelector('.online-world-card-remove')), export:[...item.querySelectorAll('.online-world-author-menu button')].some(button=>button.textContent==='导出游戏卡') }; })()`);
      assert.deepEqual(foreignCardMenuQa, { badge:true, remove:true, export:false });
      await evaluate(`closeOnlineWorldDetails()`);
      await settle();
      fs.writeFileSync(path.join(outputDir, "library-after-background-sync.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('#online-world-back').click()`);
      await settle();
      assert(calls.filter(call => call.name === "closeOnlineWorld").length > closeCallsAtLibrary);
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
      assert.equal(await evaluate(`document.querySelector('#perspective-split-card .plugin-cost-warning').textContent.includes('积分')`), true);
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
      state = { ...state, appUpdate: { status: "available", currentVersion: version, latestVersion: "9.9.9" }, releaseSecurity: { status: "update-required", verified: false, message: "发现官方新版本 v9.9.9", currentVersion: version, latestVersion: "9.9.9" } };
      await evaluate(`releaseNoticeDismissed=false`);
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#official-notice-title').textContent`), "发现新的官方版本");
      assert.equal(await evaluate(`document.querySelector('#official-notice-action').textContent`), "暂不更新");
      assert.equal(await evaluate(`document.querySelector('#official-notice-open').textContent`), "重启并安装");
      assert.equal(await evaluate(`document.querySelector('#official-notice-open').disabled`), false);
      assert.equal(await evaluate(`document.querySelector('#settings-update-action').textContent`), "重启并安装");
      assert.equal(await evaluate(`/公钥|指纹/.test(document.querySelector('#official-notice-card').textContent)`), false);
      fs.writeFileSync(path.join(outputDir, "official-update-required.png"), (await window.webContents.capturePage()).toPNG());
      const updateCalls = calls.filter(call => call.name === "requestAppUpdate").length;
      await evaluate(`document.querySelector('#official-notice-open').click()`);
      await settle();
      assert.equal(calls.filter(call => call.name === "requestAppUpdate").length, updateCalls + 1);
      state = { ...state, appUpdate: { status: "ready", currentVersion: version, latestVersion: "9.9.9", installDeferred: false }, releaseSecurity: { status: "verified", verified: true, currentVersion: version } };
      window.webContents.send("qa:onState", state);
      await settle();
      assert.equal(await evaluate(`document.querySelector('#official-notice-open').textContent`), "重启并安装");
      await evaluate(`document.querySelector('#official-notice-open').click()`);
      await settle();
      assert.equal(calls.filter(call => call.name === "requestAppUpdate").length, updateCalls + 2);
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
