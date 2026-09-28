const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { validateGameCard, summarizeGameCard, createBundledGridCard, createEditedGameCard } = require("../electron/online-world-card.cjs");
const { createEditorProject, createBlankEditorProject } = require("../electron/online-game-editor.cjs");
const { parseProgram } = require("../electron/online-world-runtime.cjs");
const { createWorld, projectWorldState } = require("../electron/grid-world-game.cjs");

const root = path.resolve(__dirname, "..");
const starter = process.argv.includes("--starter");
const output = path.join(root, "output", starter ? "editor-starter-render" : "game-card-render");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
const input = process.argv.find(arg => arg.startsWith("--card="))?.slice(7);
const base = input ? validateGameCard(JSON.parse(fs.readFileSync(input, "utf8"))) : createBundledGridCard();
const card = starter ? createEditedGameCard(base, { programHtml: createBlankEditorProject().program.html }) : base;
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
let closeCalls = 0;
let syncCalls = 0;
let saveCalls = 0;
let savedProject = null;
const handlers = {
  "app:get-version": () => version,
  "app:get-release-channel": () => "test",
  "app:get-author-info": () => ({ name: "render-qa", links: {} }),
  "backend:get-state": () => state,
  "backend:set-theme": () => state,
  "backend:list-domains": () => ({ domains: [], probing: false }),
  "credentials:load": () => null,
  "backend:list-domain-candidates": () => ({ domains: [], probing: false }),
  "online-world:get-state": () => world,
  "online-world:list-cards": () => ({ cards: [summarizeGameCard(card)] }),
  "online-world:close": () => { closeCalls += 1; return { ...world, status: "closed" }; },
  "online-world:reconnect": () => { syncCalls += 1; return world; },
  "online-world:save-editor": (_event, _id, project) => {
    saveCalls += 1;
    const edited = createEditedGameCard(card, {
      configuration: project.configuration, programHtml: project.program.html, title: project.card.title
    });
    savedProject = createEditorProject(edited);
    return { project: savedProject, cards: [summarizeGameCard(edited)] };
  }
};
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
app.whenReady().then(async () => {
  const messages = [];
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { preload: path.join(root, "electron/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true }
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
    if (starter) {
      const embedded = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith("blob:"));
      await embedded.executeJavaScript(`document.querySelector("#sync").click()`);
      for (let attempt = 0; attempt < 20 && !syncCalls; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(syncCalls, 1, "starter sync did not reach the host");
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await embedded.executeJavaScript(`document.querySelector("#sync").disabled`), false);
      assert.equal(await embedded.executeJavaScript(`document.querySelector("#status").textContent`), "宿主已返回最新结果");
      await embedded.executeJavaScript(`document.querySelector("#library").remove()`);
    }
    win.webContents.debugger.attach("1.3");
    for (const [width, height] of [[1280, 900], [420, 820]]) {
      win.setContentSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 200));
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const back=document.querySelector("#online-world-floating-back");
        const button=back.getBoundingClientRect(),frame=onlineWorldFrame.getBoundingClientRect();
        return {opacity:getComputedStyle(back).opacity,position:getComputedStyle(back).position,
          width:button.width,height:button.height,x:button.x,y:button.y,
          frameX:frame.x,frameY:frame.y,frameRight:frame.right,frameBottom:frame.bottom,
          viewportWidth:innerWidth,viewportHeight:innerHeight};
      })()`);
      assert.equal(geometry.position, "absolute");
      assert(geometry.width <= 24 && geometry.height <= 24);
      assert(Math.abs(geometry.frameX) < 1 && Math.abs(geometry.frameY) < 1);
      assert(Math.abs(geometry.frameRight - geometry.viewportWidth) < 1);
      assert(Math.abs(geometry.frameBottom - geometry.viewportHeight) < 1);
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 100 });
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector("#online-world-floating-back")).opacity`), "0");
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: geometry.x + 12, y: geometry.y + 12
      });
      await new Promise(resolve => setTimeout(resolve, 180));
      const hoverState = await win.webContents.executeJavaScript(`({
        hit:document.elementFromPoint(${geometry.x + 12},${geometry.y + 12})?.closest("button")?.id,
        hover:document.querySelector("#online-world-floating-back").matches(":hover"),
        opacity:getComputedStyle(document.querySelector("#online-world-floating-back")).opacity
      })`);
      assert.equal(hoverState.hit, "online-world-floating-back");
      assert(Number(hoverState.opacity) > 0, JSON.stringify(hoverState));
      fs.writeFileSync(path.join(output, `return-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`document.querySelector("#online-world-floating-back").click()`);
    for (let attempt = 0; attempt < 20 && !closeCalls; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(closeCalls, 1);
    assert.equal(await win.webContents.executeJavaScript(`onlineWorldInLibrary && onlineWorldFrame.src==="about:blank"`), true);

    await win.webContents.executeJavaScript(`onlineWorldEditorProject=${JSON.stringify(createEditorProject(card))};
      selectedOnlineWorldEditorId="render-fixture";showPage("online-editor");renderOnlineWorldEditorProject();
      document.querySelector('[data-editor-tab="prompts"]').click();
      document.querySelector("#online-editor-pre-text").value="前置保留";
      document.querySelector("#online-editor-pre-prompt").value="主提示词保留";
      document.querySelector("#online-editor-post-text").value="后置保留";
      document.querySelector("#online-editor-save").click();`);
    for (let attempt = 0; attempt < 20 && !saveCalls; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(saveCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await win.webContents.executeJavaScript(`["pre-text","pre-prompt","post-text"].map(id=>document.querySelector("#online-editor-"+id).value)`),
      ["前置保留", "主提示词保留", "后置保留"]);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll(".online-editor-header #online-editor-import,.online-editor-header #online-editor-new,.online-editor-side-note").length`), 0);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector("#online-editor-import").closest("dialog").id`), "online-editor-project-picker");
    for (const [width, height] of [[1280, 900], [420, 820]]) {
      win.setContentSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector("#online-world-editor-page").scrollWidth > innerWidth + 1`), false);
      assert.equal(await win.webContents.executeJavaScript(`(() => {
        const settings=document.querySelector("#settings-toggle").getBoundingClientRect();
        return [...document.querySelectorAll(".online-editor-actions button")].some(button=>{
          const rect=button.getBoundingClientRect();
          return rect.left<settings.right && rect.right>settings.left && rect.top<settings.bottom && rect.bottom>settings.top;
        });
      })()`), false, "editor command overlaps settings");
      fs.writeFileSync(path.join(output, `editor-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.webContents.debugger.detach();
    fs.writeFileSync(path.join(output, "interaction-result.json"), JSON.stringify({
      passed: true, starter, syncCalls, closeCalls, saveCalls, promptValues: savedProject.configuration.pre_prompt
    }, null, 2));
    console.log("Game return, starter sync, and editor prompt roundtrip QA passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
