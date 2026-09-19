// Offline QA for the production preload in a sandboxed renderer.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
const output = path.join(root, "release-cache", `${version}-sandbox-validation`);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "electron-profile"));

const state = {
  loggedIn: false,
  profileId: "sandbox-qa",
  mode: "login",
  uiTheme: "dark",
  origin: "https://acepro.store",
  domainSelected: true,
  originLocked: false,
  releaseSecurity: { status: "development", verified: true, message: "沙箱界面测试", currentVersion: version },
  account: {},
  room: null,
  work: null,
  conversation: { items: [] },
  models: { items: [] },
  characterProfiles: { selectedId: null, items: [] },
  plugins: { definitions: [], currentRuns: [], lastRuns: [] },
  workSettings: {}
};
const handlers = new Map([
  ["app:get-version", () => version],
  ["app:get-release-channel", () => "mirror"],
  ["app:open-official-release-page", () => true],
  ["app:get-author-info", () => ({
    name: "八爪毛米",
    links: {
      homepage: { key: "homepage", label: "作者主页", configured: true, url: "https://staging.aiero.cc/zh/profile/39404f0e-7678-45a1-86c6-9a21116bacbd" },
      releasePost: { key: "releasePost", label: "风月发布帖", configured: false, url: null },
      feedbackPost: { key: "feedbackPost", label: "问题反馈帖", configured: false, url: null },
      github: { key: "github", label: "GitHub 下载页", configured: true, url: "https://github.com/pumpcatkin/fengyue-link/releases/latest" }
    }
  })],
  ["app:open-author-link", () => true],
  ["app:quit", () => true],
  ["backend:get-state", () => state],
  ["backend:set-theme", () => state],
  ["backend:set-bounds", () => true],
  ["credentials:load", () => null],
  ["backend:list-domain-candidates", () => ({ domains: [{ origin: state.origin, online: true, latency: 10 }], probing: false })],
  ["backend:list-domains", () => ({ domains: [{ origin: state.origin, online: true, latency: 10 }], probing: false })]
]);
for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(root, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.on("console-message", event => {
    const message = String(event?.message || "");
    if (/error|refused|violation/i.test(message)) errors.push(message);
  });
  try {
    await window.loadFile(path.join(root, "electron", "desktop", "index.html"));
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`({
      version: document.querySelector('#app-version')?.textContent,
      title: document.title,
      hasBackend: typeof window.fengyueBackend?.getState === 'function',
      loginVisible: !document.querySelector('#login-panel')?.classList.contains('hidden'),
      securityCardAbsent: document.querySelector('#release-security-card') === null,
      officialNoticeVisible: !document.querySelector('#official-notice-overlay')?.classList.contains('hidden'),
      officialNoticeTitle: document.querySelector('#official-notice-title')?.textContent,
      publicKeyHidden: !/公钥|指纹/.test(document.querySelector('#official-notice-card')?.textContent || ''),
      authorName: document.querySelector('#author-name')?.textContent,
      githubEnabled: !document.querySelector('[data-author-link="github"]')?.disabled,
      missingHomepageDisabled: document.querySelector('[data-author-link="homepage"]')?.disabled
    })`, true);
    assert.deepEqual(result, {
      version: `v${version}`,
      title: "风月联机工具",
      hasBackend: true,
      loginVisible: true,
      securityCardAbsent: true,
      officialNoticeVisible: false,
      officialNoticeTitle: "正在对照版本号",
      publicKeyHidden: true,
      authorName: "八爪毛米",
      githubEnabled: true,
      missingHomepageDisabled: false
    });
    fs.writeFileSync(path.join(output, "official-notice.png"), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript("document.querySelector('#official-notice-action').click()", true);
    Object.assign(state, {
      loggedIn: true,
      mode: "lobby",
      account: { username: "layout-qa", accountId: "layout-qa", points: 100, level: 2 }
    });
    window.webContents.send("backend:state", state);
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript("document.querySelector('#enter-multiplayer').click()", true);
    await new Promise(resolve => setTimeout(resolve, 100));
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const main = rect('#multiplayer-page main');
      const home = rect('#back-home');
      const surfaces = rect('.topbar-surface-switcher');
      const intro = rect('#show-intro');
      const game = rect('#show-game');
      const settings = rect('#settings-toggle');
      return {
        homeParent: document.querySelector('#back-home').parentElement.className,
        surfacesParent: document.querySelector('.topbar-surface-switcher').parentElement.className,
        centerOffset: Math.abs((surfaces.left + surfaces.right) / 2 - (main.left + main.right) / 2),
        yOffsets: [home, intro, game].map(item => Math.abs((item.top + item.bottom) / 2 - (settings.top + settings.bottom) / 2)),
        ordered: home.right < intro.left && surfaces.right < settings.left
      };
    })()`, true);
    assert.equal(geometry.homeParent, "topbar");
    assert.equal(geometry.surfacesParent, "topbar");
    assert.ok(geometry.centerOffset <= 1, `surface controls are ${geometry.centerOffset}px off center`);
    assert.ok(geometry.yOffsets.every(offset => offset <= 1), `top controls are not aligned: ${geometry.yOffsets}`);
    assert.equal(geometry.ordered, true);
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, "multiplayer-layout.png"), screenshot.toPNG());
    assert.deepEqual(errors, []);
    console.log(`Sandboxed production preload QA passed: ${output}`);
  } finally {
    window.destroy();
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
