const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { validateGameCard, summarizeGameCard } = require("../electron/online-world-card.cjs");
const { parseProgram } = require("../electron/online-world-runtime.cjs");
const { createWorld, projectWorldState } = require("../electron/grid-world-game.cjs");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "output", "game-card-render");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
const input = process.argv.find(arg => arg.startsWith("--card="))?.slice(7);
const card = validateGameCard(JSON.parse(fs.readFileSync(input, "utf8")));
const program = parseProgram(card.companion.configuration.app.description, card.gameId);
const version = require("../package.json").version;
const state = {
  loggedIn: true, profileId: "render-qa", mode: "lobby", uiTheme: "dark",
  origin: card.companion.origin, domainSelected: true, originLocked: false,
  releaseSecurity: { status: "development", verified: true, currentVersion: version },
  account: { accountId: card.companion.authorAccountId, username: "render-qa" },
  room: null, work: null, conversation: { items: [] }, models: { items: [] },
  characterProfiles: { selectedId: null, items: [] },
  plugins: { definitions: [], currentRuns: [], lastRuns: [] }, workSettings: {}
};
const world = {
  status: "needs-initialization", initialized: false, isServerOwner: true, isAuthor: true,
  account: state.account, work: { id: card.companion.workId },
  program, programHtml: program.html, world: null, control: null,
  localPreferences: {}, history: {}, loadProgress: { active: false }, card: summarizeGameCard(card)
};
const handlers = {
  "app:get-version": () => version,
  "app:get-release-channel": () => "mirror",
  "app:get-author-info": () => ({ name: "render-qa", links: {} }),
  "backend:get-state": () => state,
  "backend:set-theme": () => state,
  "backend:list-domains": () => ({ domains: [], probing: false }),
  "credentials:load": () => null,
  "backend:list-domain-candidates": () => ({ domains: [], probing: false }),
  "online-world:get-state": () => world,
  "online-world:list-cards": () => []
};
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
app.whenReady().then(async () => {
  const messages = [];
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { preload: path.join(root, "electron/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on("console-message", event => messages.push({ level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber }));
  try {
    await win.loadFile(path.join(root, "electron/desktop/index.html"));
    await new Promise(resolve => setTimeout(resolve, 300));
    await win.webContents.executeJavaScript(`document.querySelector("#official-notice-action").click();`);
    await win.webContents.executeJavaScript(`showPage("online-world");onlineWorldInLibrary=false;renderOnlineWorld(${JSON.stringify(world)});`);
    const unopened = await win.webContents.executeJavaScript(`({
      visible:!document.querySelector("#online-world-unopened").classList.contains("hidden"),
      title:document.querySelector("#online-world-unopened-title").textContent,
      frameHidden:onlineWorldFrame.classList.contains("hidden"),
      src:onlineWorldFrame.src
    })`);
    assert.equal(unopened.visible, true);
    assert.equal(unopened.frameHidden, true);
    assert.equal(unopened.src, "about:blank");
    assert.equal(unopened.title, /^猎艳疆土\([1-5]服\)$/.test(card.title)
      ? card.title : card.companion.name.replace(/\[[a-f0-9]{16}\]$/i, ""));
    fs.writeFileSync(path.join(output, "unopened.png"), (await win.webContents.capturePage()).toPNG());
    Object.assign(world, {
      status: "ready", initialized: true,
      world: projectWorldState(createWorld({ authorityAccountId: state.account.accountId }), state.account.accountId, Date.now())
    });
    await win.webContents.executeJavaScript(`renderOnlineWorld(${JSON.stringify(world)});`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const frames = [];
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      frames.push({ url: frame.url, content: await frame.executeJavaScript(`({
        title:document.title, text:document.body?.innerText?.slice(0,800),
        size:[innerWidth,innerHeight], elements:document.querySelectorAll("*").length
      })`).catch(error => ({ error: error.message })) });
    }
    const frameState = await win.webContents.executeJavaScript(`({
      ready:onlineWorldFrameReady, src:onlineWorldFrame.src,
      rect:JSON.stringify(onlineWorldFrame.getBoundingClientRect()),
      display:getComputedStyle(onlineWorldFrame).display
    })`);
    fs.writeFileSync(path.join(output, "render.png"), (await win.webContents.capturePage()).toPNG());
    const result = { unopened, frameState, frames, messages };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert.equal(frameState.ready, true);
    assert.equal(frameState.display, "block");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
