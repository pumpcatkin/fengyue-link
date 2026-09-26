import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";


describe("Electron platform API regressions", () => {
  it("uses data wording in the pre-entry loading interface", () => {
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    expect(html).toContain('id="online-world-loading-count">正在查询数据数量…');
    const countLine = renderer.split("\n").find(line => line.includes('querySelector("#online-world-loading-count")'));
    expect(countLine).toContain(" 条数据");
    expect(countLine).not.toContain("评论");
  });
  it("persists a refreshed companion program into the local card library and installed JSON sources", () => {
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(source).toContain("this.persistRefreshedOnlineWorldCard(card, refreshedCard)");
    expect(source).toContain("refreshedCard?.companion?.workId === card.companion.workId");
    expect(source).toContain("this.persistRefreshedOnlineWorldCard(sourceCard, migratedCard)");
    expect(source).toContain("event: \"game-card-program-refreshed\"");
    expect(source).toContain("atomicWriteFileSync(fs, file, `${JSON.stringify(refreshed, null, 2)}\\n`");
  });
  it("never requests the one-based platform message API with page zero", () => {
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/installed-apps[^`"']*\/messages[^`"']*page=0/);
  });

  it("keeps the captured conversation frame wired to the hidden game page", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const css = readFileSync(new URL("../electron/desktop/game-frame.css", import.meta.url), "utf8");
    expect(main).toContain('handleLocalIpc("backend:game-pointer"');
    expect(preload).toContain('gamePointer: payload => ipcRenderer.invoke("backend:game-pointer"');
    expect(renderer).toContain('gameFrame.addEventListener("pointerdown"');
    expect(css).toMatch(/pointer-events:\s*auto/);
  });

  it("stabilizes React-controlled long reply edits before saving", () => {
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(source).toContain("editor._valueTracker?.setValue(previous)");
    expect(source).toContain("document.execCommand('insertText',false,expectedOutput)");
    expect(source).toContain("findMessageButton(target, '#customized-edit-button')");
    expect(source).toContain("平台没有保存工具文本框中的完整回复");
    expect(html).toContain('id="message-edit-form" class="message-edit-form hidden"');
    expect(html).not.toContain('id="message-edit-overlay"');
    expect(renderer).toContain('api.runMessageOperation("edit",document.querySelector("#message-edit-value").value)');
  });

  it("mounts the hidden conversation page before reading conversations", () => {
    const source = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(source).toContain("async ensureGameSurfaceMounted");
    expect(source).toMatch(/async readConversationList\([^)]*\)[\s\S]*await this\.ensureGameSurfaceMounted/);
    expect(source).toContain("background-page-mounted");
    expect(source).toContain("stayHidden: true, stayAwake: true");
    expect(source).not.toContain("mounted:Boolean(document.querySelector('#installedBuiltInCss");
    expect(source).toContain('current.source === "local-anchor"');
  });

  it("hides native message actions and exposes synchronized desktop actions", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain(".chat-container .MuiStack-root.css-1ajg1ui");
    expect(main).toMatch(/\.MuiStack-root\.css-1ajg1ui button[\s\S]*display:\s*none !important/);
    expect(main).toContain('liveView.webContents.on("did-finish-load"');
    expect(main).toContain('"message-operation"');
    expect(preload).toContain("runMessageOperation");
    expect(html).toContain('id="refresh-latest"');
    expect(html).toContain('id="edit-latest"');
    expect(html).toContain('id="delete-latest"');
  });

  it("keeps both work pages resident and reveals the intro before background preparation completes", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const prepareStart = main.indexOf("async prepareWorkSurfaces()");
    const prepareEnd = main.indexOf("async prepareGuestIntroSurface()", prepareStart);
    const prepare = main.slice(prepareStart, prepareEnd);
    expect(main).toContain("this.liveGameSurface = true");
    expect(main).toContain("const liveView = new WebContentsView");
    expect(main).toContain("this.window.contentView.addChildView(this.gameSurface)");
    expect(main).toContain("keepGameSurfaceResident()");
    expect(main).toContain("keepIntroSurfaceAwake()");
    expect(main).toContain('event: "background-tabs-ready"');
    expect(main).not.toMatch(/this\.gameSurface\.(?:hide|close)\(/);
    expect(main).toContain("this.gameSurface.webContents.close()");
    expect(prepare.indexOf("this.preparePlatformModels(1)")).toBeLessThan(prepare.indexOf("this.loadSurfaceUrl(this.gameSurface"));
    expect(prepare).toContain("workVisualReady: true");
    expect(prepare.indexOf("workVisualReady: true")).toBeLessThan(prepare.indexOf("await Promise.all([introTask, mountedTask, conversationTask, modelTask])"));
  });

  it("keeps the resident page alive without periodically stealing editor focus", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const residentStart = main.indexOf("keepGameSurfaceResident() {");
    const residentEnd = main.indexOf("scheduleBackgroundDataRefresh", residentStart);
    const resident = main.slice(residentStart, residentEnd);
    expect(resident).not.toContain("setFocusable(");
    expect(resident).not.toContain("setIgnoreMouseEvents(");
    expect(main).toContain("function accountSignature");
    expect(main).toContain("previousAccount !== accountSignature(this.account)");
    expect(renderer).toContain("if(key===lastSurfaceBoundsKey)return");
  });

  it("observes rejected background timer promises instead of leaking unhandled rejections", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const constructor = main.slice(main.indexOf("constructor(window, profileId, releaseSecurity, updateService)"), main.indexOf("state(extra = {})"));
    expect(constructor).toContain('this.runBackgroundTask("login-state"');
    expect(constructor).toContain('this.runBackgroundTask("room-protocol"');
    expect(main).toContain('this.appendSessionLog("background-task"');
  });

  it("retains the offscreen frame path only as an emergency fallback", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const createStart = main.indexOf("createPlatformWindow() {");
    const createEnd = main.indexOf("ensureGameOffscreenPainting()", createStart);
    const createLiveView = main.slice(createStart, createEnd);
    expect(createLiveView).toContain("const hiddenWindow = new BrowserWindow");
    expect(createLiveView).toContain("offscreen: true");
    expect(createLiveView).toContain('.on("paint"');
    expect(main).toContain("this.gameFrameTimer = this.liveGameSurface ? null");
    expect(main).toContain("presentationFrameForCrop(crop)");
    expect(main).toContain("image.toJPEG(92)");
    expect(main).toContain('mimeType: "image/jpeg"');
    expect(main).toContain("if (!this.liveGameSurface)");
    expect(main).toContain("viewportWidth:window.innerWidth");
    expect(html).toContain('<canvas id="game-frame"');
    expect(renderer).toContain("createImageBitmap(new Blob([bytes]");
    expect(renderer).toContain('getContext("2d", { alpha: false, desynchronized: true })');
    expect(renderer).not.toContain("gameFrame.src=frame.dataUrl");
  });

  it("reopens the visible game surface after a selected conversation hydrates", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain('const reopenGameSurface = ["loading-game", "game", "game-empty"].includes(this.mode)');
    expect(main).toContain("const ready = await this.applyGameIsolation(reopenGameSurface)");
    expect(main).toContain("if (ready) await this.showCapturedGameSurface({ conversationSelected: true })");
    expect(main).toContain('if (found?.found && this.mode === "game-empty")');
    expect(main).toContain("this.emit({ conversationBecameReady: true })");
  });

  it("locks new conversations for every room role", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    expect(main).toContain('if (this.room) throw new Error("房间开启期间不能新建会话")');
    expect(renderer).toContain('newButton.disabled=Boolean(next.conversationBusy)||!next.work||Boolean(next.room)');
  });

  it("auto-selects a production node and rebases every work page to the login node", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain("OFFICIAL_DOMAIN_DIRECTORY_URLS");
    expect(main).toContain("FALLBACK_PLATFORM_ORIGINS");
    expect(main).toContain("for (const origin of origins) TRUSTED_PLATFORM_ORIGINS.add(origin)");
    expect(main).toContain("mergePublishedOrigins(directorySources.filter(item => item.ok).map(item => item.html))");
    expect(main).toContain("directorySources.some(item => !item.ok)");
    expect(main).toContain("const origin = normalizePublishedOrigin(value)");
    expect(renderer).toContain("async function useManualDomain()");
    expect(html).toContain('id="manual-domain"');
    expect(html).toContain('id="use-manual-domain"');
    expect(main).toContain("this.anchorNavigationArmed = false");
    expect(renderer).toContain("const fastest=sortedDomains().find");
    expect(renderer).not.toContain("测试节点");
    expect(main).toContain("function platformUrlForOrigin(origin, value");
    expect(main).toContain('platformUrlForOrigin(this.origin, "/zh/explore/apps?ranking=daily_rank&display=extended").href');
    expect(main).toContain("const url = platformUrlForOrigin(this.origin, value)");
    expect(main).toContain("const url = platformUrlForOrigin(this.origin, this.work.url)");
    expect(main).toContain("url: platformUrlForOrigin(this.origin, this.room.work.suffix).href");
    expect(main).toContain("void this.surface.webContents.loadURL(platformUrlForOrigin(this.origin, url).href)");
    expect(preload).toContain('switchOrigin: origin => ipcRenderer.invoke("backend:switch-origin", origin)');
    expect(preload).toContain('logout: () => ipcRenderer.invoke("backend:logout")');
    expect(preload).toContain('setSettingsVisible: visible => ipcRenderer.invoke("backend:set-settings-visible", visible)');
  });

  it("restores the selected node immediately and keeps node probing off the login path", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const setOriginStart = main.indexOf("async setOrigin(value)");
    const switchOriginStart = main.indexOf("async switchOrigin(value)");
    const setOrigin = main.slice(setOriginStart, main.indexOf("async logout", setOriginStart));
    const switchOrigin = main.slice(switchOriginStart, main.indexOf("async evaluateLogin", switchOriginStart));
    expect(main).toContain("function loadSelectedOrigin(profileId)");
    expect(main).toContain("saveSelectedOrigin(this.profileId, this.origin)");
    expect(main).toContain("function currentDomainCandidates(selectedOrigin = null)");
    expect(main).toContain("AbortSignal.timeout(4_000)");
    expect(main).toContain("mapConcurrent(origins, 12");
    expect(main).toContain("AbortSignal.timeout(5_000)");
    expect(setOrigin).not.toContain("await discoverDomainStatuses");
    expect(switchOrigin).not.toContain("await discoverDomainStatuses");
    expect(preload).toContain('listDomainCandidates: () => ipcRenderer.invoke("backend:list-domain-candidates")');
    expect(renderer).toContain("api.listDomainCandidates()");
    expect(renderer).toContain('item.online===false?"检测失败":"待检测"');
    expect(renderer).toContain("const refreshing=refreshDomains(false)");
    expect(main).toContain("async prepareLoginPage()");
    expect(main).toContain("if (this.domainSelected) void this.prepareLoginPage()");
  });

  it("uses cancellable node rotation and protects each account profile from duplicate instances", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const loginStart = main.indexOf("async login({ account, password, remember, autoLogin = false })");
    const loginEnd = main.indexOf("closeOAuthWindows()", loginStart);
    const login = main.slice(loginStart, loginEnd);
    expect(main).toContain("async readAccountSnapshot({ includeDetails = true, webContents = null, allowSubresourceLoading = false } = {})");
    expect(main).toContain("[point, personalProfile] = await Promise.all([");
    expect(login).toContain("readAccountSnapshot({ includeDetails: false, webContents: anchor.webContents, allowSubresourceLoading: true })");
    expect(login).not.toContain("authenticationDeadline");
    expect(login).toContain("await this.loadLoginPage(anchor, origin, signal)");
    expect(login).toContain("await pauseLogin(250, signal)");
    expect(login).toContain("while (!accountElement || !password)");
    expect(login).toContain("element.shadowRoot");
    expect(login).toContain('input[name="username"]');
    expect(login).toContain('event: "authenticated"');
    expect(login).not.toContain("await this.refreshAccount(true)");
    expect(main).toContain("runLoginFailover({");
    expect(main).toContain("orderLoginCandidates(directory?.domains, { includeUnmeasured: true");
    expect(main).toContain("void discoverDomainStatuses(false).catch");
    expect(preload).toContain('autoLogin: credentials => ipcRenderer.invoke("backend:auto-login", credentials)');
    expect(preload).toContain('cancelLogin: () => ipcRenderer.invoke("backend:cancel-login")');
    expect(renderer).toContain('if(saved?.autoLogin&&!initial.loggedIn)await submitCredentials({automatic:true})');
    expect(main).toContain("function acquireProfileInstanceLock(profileId)");
    expect(main).toContain('fs.openSync(file, "wx", 0o600)');
    expect(main).toContain("账号实例“${profileId}”已经打开");
    expect(main).toContain('app.on("will-quit", () => {');
    expect(main).toContain("releaseProfileInstanceLock(profileInstanceLock);");
  });

  it("keeps behavior diagnostics across restarts and exports them with Ctrl+Shift+8", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const service = readFileSync(new URL("../electron/online-world-service.cjs", import.meta.url), "utf8");
    expect(main).toContain("bindDiagnosticExportShortcut(webContents)");
    expect(main).toContain("globalShortcut");
    expect(main).toContain('CommandOrControl+Shift+8');
    expect(main).toContain("registerDiagnosticGlobalShortcut()");
    expect(main).toContain("unregisterDiagnosticGlobalShortcut()");
    expect(main).toContain('String(input.code || "") === "Digit8"');
    expect(main).toContain("exportDiagnosticLogToDesktop()");
    expect(main).toContain('app.getPath("desktop")');
    expect(main).not.toContain("fs.rmSync(this.sessionLogFile, { force: true });\n    catch {}");
    expect(service).toContain('event: "player-behavior"');
    expect(service).toContain('source: "public-ledger"');
  });

  it("uses the platform model endpoints and keeps guest context visible while waiting", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain('/workspaces/model-list');
    expect(main).toContain('/apps/config');
    expect(main).toContain('record?.model_price');
    expect(main).toContain('record?.success_rate');
    expect(renderer).toContain('MODEL_FAMILIES');
    expect(renderer).toContain('await api.setModel({provider:item.provider,model:item.model})');
    expect(html).toContain('id="model-family-tabs"');
    expect(html).not.toContain('id="refresh-models"');
    expect(html).not.toContain('id="apply-model"');
    expect(renderer).toContain('["loading-game","game","game-empty","guest-waiting","guest-syncing"]');
  });

  it("presents the revised home entries and highlights missing character setup", () => {
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../electron/desktop/styles.css", import.meta.url), "utf8");
    const theme = readFileSync(new URL("../electron/desktop/theme.css", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    expect(html).toContain('<b>联机同乐</b>');
    expect(html).toContain('<b>在线游戏世界</b><small>多人在线的非风月小游戏</small>');
    expect(html).toContain('id="auto-login"');
    expect(styles).toContain("font-size:34px;font-style:italic");
    expect(styles).toContain("translateX(calc(-22px - .16em))");
    expect(styles).toContain("font-size:12px;font-weight:700");
    expect(theme).toContain(".feature-card.needs-attention");
    expect(theme).toContain(".feature-card.primary > small");
    expect(renderer).toContain('classList.toggle("needs-attention",needsSetup)');
    expect(renderer).toContain('"首次联机前，请先完善角色资料"');
  });

  it("mounts the online game world between home entries behind a no-network sandbox", () => {
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../electron/online-world-runtime.cjs", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(html.indexOf('id="enter-multiplayer"')).toBeLessThan(html.indexOf('id="enter-online-world"'));
    expect(html.indexOf('id="enter-online-world"')).toBeLessThan(html.indexOf('id="edit-profiles"'));
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toMatch(/id="online-world-frame"[^>]*allow="autoplay"/);
    expect(html).not.toMatch(/id="online-world-frame"[^>]*allow-same-origin/);
    expect(html).not.toContain('id="online-world-url"');
    expect(html).not.toContain('id="online-world-card"');
    expect(html).not.toContain('id="online-world-card-binding"');
    expect(html).toContain('id="online-world-library-grid"');
    expect(html).toContain('id="online-world-detail"');
    expect(html).toContain('id="online-world-profile"');
    expect(html).not.toContain("选择一个世界，和朋友继续冒险。");
    expect(html).not.toContain('id="online-world-featured"');
    expect(html).toContain('id="online-world-detail-title">游戏详情');
    expect(html).toContain('id="online-world-import-card"');
    expect(html).toContain('id="online-world-drop-hint"');
    expect(html).not.toContain('id="online-world-export-card"');
    expect(renderer).toContain("online-world-author-badge");
    expect(html).toContain("frame-src 'self' blob:");
    expect(renderer).toContain('event.source!==onlineWorldFrame.contentWindow');
    expect(renderer).toContain("onlineWorldMigrationRetryAt=Date.now()+delay");
    expect(renderer).toContain("followOnlineWorldMigration(onlineWorldState)");
    expect(renderer).toContain("!next?.initialized&&!next?.isServerOwner&&!migrating");
    expect(renderer).toContain("游戏卡迁移地址暂时不可用，将自动重试");
    expect(renderer).not.toContain('ONLINE_WORLD_SHOWCASE_TITLES');
    expect(renderer).toContain('className="online-world-card-tile"');
    expect(renderer).toContain("URL.createObjectURL(new Blob([next.programHtml]");
    expect(preload).not.toContain('activateOnlineWorldProgram: () => ipcRenderer.invoke("online-world:activate-program")');
    expect(preload).toContain('importOnlineWorldCard: () => ipcRenderer.invoke("online-world:import-card")');
    expect(preload).toContain('webUtils.getPathForFile(file)');
    expect(preload).toContain('ipcRenderer.invoke("online-world:import-card-files", paths)');
    expect(preload).toContain('removeOnlineWorldCard: libraryId => ipcRenderer.invoke("online-world:remove-card", libraryId)');
    expect(preload).toContain('updateOnlineWorldCardCloud: libraryId => ipcRenderer.invoke("online-world:update-cloud-card", libraryId)');
    expect(main).toContain('handleLocalIpc("online-world:list-cards"');
    expect(main).toContain("loadGameCardLibrary(this.onlineWorldCardFile, null)");
    expect(main).not.toContain("onlineWorldCardExternalizationPath");
    expect(main).toContain('handleLocalIpc("online-world:import-card"');
    expect(main).toContain('handleLocalIpc("online-world:import-card-files"');
    expect(main).toContain('path.join(app.getPath("userData"), "游戏卡")');
    expect(main).toContain('path.join(resourcesPath, "game-library")');
    expect(main).toContain("mergeBundledGameCardDirectory(");
    expect(main).toContain('scanGameCardDirectory(this.onlineWorldCardInstallDirectory)');
    expect(packageJson.build.extraResources).toContainEqual({
      from: "game-cards",
      to: "game-library",
      filter: ["**/*.json"]
    });
    expect(main).toContain('handleLocalIpc("online-world:remove-card"');
    expect(main).toContain('handleLocalIpc("online-world:export-card"');
    expect(main).toContain('handleLocalIpc("online-world:update-cloud-card"');
    expect(renderer).toContain('className="online-world-card-remove"');
    expect(renderer).toContain('updateCloudButton.textContent="更新云端储存"');
    expect(renderer).toContain("这会将本地目前的json上传至风月，所有玩家的版本都会更新，是否进行？");
    expect(renderer).toContain('onlineWorldSetup.addEventListener("drop"');
    expect(renderer).toContain('api.importOnlineWorldCardFiles(files)');
    expect(main).toContain("scheduleOnlineWorldMigrationResume");
    expect(main).toContain('event: "migration-resume-complete"');
    expect(renderer).toContain('badge.textContent="⋯"');
    expect(renderer).not.toContain("fyow:last-work-url");
    expect(main).toContain('handleLocalIpc("online-world:submit-intent"');
    expect(main).not.toContain('handleLocalIpc("online-world:activate-program"');
    expect(preload).toContain('sendOnlineWorldDirect: message => ipcRenderer.invoke("online-world:send-direct", message)');
    expect(renderer).toContain('if(event.data.type==="direct")');
    expect(readFileSync(new URL("../electron/desktop/online-world/grid-conquest/index.html", import.meta.url), "utf8")).toContain('id="direct-inbox"');
    const gridGame = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/game.js", import.meta.url), "utf8");
    const gridHtml = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/index.html", import.meta.url), "utf8");
    const gridStyles = readFileSync(new URL("../electron/desktop/online-world/grid-conquest/styles.css", import.meta.url), "utf8");
    expect(gridGame).toMatch(/const DEFAULT_VISIBLE_CELLS\s*=\s*12/);
    expect(gridGame).toMatch(/if \(event\.button !== 2\) return/);
    expect(gridGame).toContain('viewport.addEventListener("contextmenu"');
    expect(gridGame).toContain("if (ownPlayer()) joinSubmitting = false");
    expect(gridGame).toContain("applyHostedState(event.data.result.state, false)");
    expect(gridGame).toContain('const HOST_PROTOCOL = "fyow-host/1"');
    expect(gridGame).toContain("event.source !== parent");
    expect(gridGame).toContain("pendingHostKeys.has(key)");
    expect(gridGame).toContain('timeoutMessage: "保存偏好请求超时，请重试"');
    expect(gridGame).toContain('savePreferencesButton.addEventListener("click", savePreferences)');
    expect(gridGame).toContain('preferencesForm.addEventListener("submit", savePreferences)');
    expect(gridHtml).toContain('id="save-preferences" class="primary" type="button"');
    expect(renderer).toContain('if(onlineWorldInLibrary){if(expectsResult)replyError');
    expect(gridGame).toContain('type: "prepare-join"');
    expect(gridGame).toContain('openGeneralAction({ type: "recall"');
    expect(gridGame).toContain('intent = { type: "recall-general", generalId: action.generalId }');
    expect(gridGame).toContain("joinDraft.preview = event.data.result.joinPreview");
    expect(gridGame).toContain('playSound("victory")');
    expect(gridGame).toContain('playSound("letter")');
    expect(gridHtml).toMatch(/<button id="sound-knob"[^>]*role="slider"/);
    expect(gridHtml).toContain('id="sound-volume" class="visually-hidden" type="range"');
    expect(gridHtml).not.toContain('id="sound-toggle"');
    expect(gridGame).toContain("function ensureAudioReady()");
    expect(gridGame).toContain("context.resume?.()");
    expect(gridGame).toContain('document.addEventListener("pointerdown", event => {');
    expect(gridGame).toContain('button !== soundKnob) playSound("click")');
    expect(gridGame).toContain('if (!volume || !context || context.state === "closed") return');
    expect(renderer).toContain('const ONLINE_WORLD_SOUND_VOLUME_KEY = "fyow:grid-sound-volume"');
    expect(renderer).toContain('const supportedTypes=["ready","sound"');
    expect(renderer).toContain('uiPreferences:{...(onlineWorldState.uiPreferences||{}),soundVolume:onlineWorldSoundVolume()}');
    expect(gridGame).toContain("next?.uiPreferences?.soundVolume");
    expect(gridGame).toContain("revision !== pendingSoundRevision");
    expect(gridGame).toContain("!pendingSoundRevision && !soundKnobDrag");
    expect(renderer).toContain('postOnlineWorldFrame("sound",{volume:onlineWorldSoundVolume(),revision:Number(event.data.revision||0)})');
    expect(gridHtml).toContain('id="points-balance-value"');
    expect(gridHtml).toContain('id="model-usage-log"');
    expect(gridGame).toContain("modelUsageEvents");
    expect(gridGame).toContain('item?.points?.total == null ? "结算中"');
    expect(main).toContain("resolvedModelPointUsage(result.points || result.usage");
    expect(main).toContain('await this.refreshOnlineWorldPoints(task, "before")');
    expect(main).toContain('await this.refreshOnlineWorldPoints(task, "after")');
    expect(main).toContain("newConversation: true");
    expect(renderer).toContain('const ONLINE_WORLD_HOST_PROTOCOL = "fyow-host/1"');
    expect(renderer).toContain("ONLINE_WORLD_HOST_MESSAGE_LIMIT");
    expect(renderer).toContain("replyResult({cancelled:true})");
    expect(gridHtml).toContain('id="training-target"');
    expect(gridHtml).toContain('id="general-measurements"');
    expect(gridHtml).toContain('id="join-reroll"');
    expect(gridHtml).toContain('id="join-general-core"');
    expect(gridGame).toContain('type: "cultivate-player"');
    expect(gridGame).toContain('type: "cultivate-general"');
    expect(gridGame).not.toContain('type: "power-train"');
    expect(gridStyles).toMatch(/aside\s*\{[^}]*overflow:\s*hidden auto/);
    expect(gridStyles).toMatch(/html, body\s*\{[^}]*overflow:\s*hidden/);
    expect(main).toContain("async platformServerTime()");
    expect(main).toContain('this.platformRequest("/go/api/account/profile", { timeout: 5000, attempts: 1 })');
    expect(runtime).toContain("connect-src 'none'");
    expect(runtime).toContain("worker-src 'none'");
  });

  it("uses the Windows system proxy for every Electron session and leaves work selection unbounded", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain('targetSession.setProxy({ mode: "system" })');
    expect(main).toContain("session.fromPartition(this.partition)");
    expect(main).toContain('configureSystemProxy(session.defaultSession, "default-session")');
    expect(main).toContain('event: "default-system-proxy"');
    const chooseStart = main.indexOf("async chooseWork()");
    const chooseEnd = main.indexOf("async setUiTheme", chooseStart);
    const choose = main.slice(chooseStart, chooseEnd);
    expect(choose).toMatch(/"作品选择页",\s*0/);
    expect(main).toContain("if (!Number.isFinite(boundedTimeout) || boundedTimeout <= 0)");
  });

  it("keeps a live login stable through transient token and network state", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain("authenticated:null, reason:'missing-token'");
    expect(main).toContain("if (snapshot.authenticated == null) return;");
    expect(main).toContain("confirmAuthenticationFailure(source, reason");
    expect(main).toContain("this.authFailureStreak >= 3 && elapsedMs >= 9000");
    expect(main).toContain('event: confirmed ? "authentication-loss-confirmed" : "authentication-loss-deferred"');
    expect(main).toContain('event: "authentication-loss-held-during-active-session"');
    expect(main).toContain("if (this.work || this.room || this.onlineWorldService?.work)");
    expect(main).toContain('this.clearAuthenticationFailures("account-refresh")');
    expect(main).not.toContain("const next = snapshot ? Boolean(snapshot.authenticated) : await this.evaluateLogin()");
  });

  it("writes multiplayer prompts only to a real session and cleans a blank-session bootstrap", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const syncStart = main.indexOf("async syncHostMultiplayerConversationConfig");
    const sendStart = main.indexOf("async sendModelInputAndCapture");
    expect(main).toContain("async ensureHostConversationForPromptConfig");
    expect(main).toContain("多人会话配置初始化:");
    expect(main).toContain("async removeHostPromptBootstrapTurn");
    expect(main).toContain('{ method: "DELETE", timeout: 10000 }');
    expect(main).toContain("body: { app_id: appId, conversation_id: conversationId, is_global: false, ...patch }");
    expect(main).not.toContain('conversation_id: "", is_global: false');
    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncStart).toBeLessThan(sendStart);
  });

  it("adapts a selected work from every conversation's last AI answer and persists the fragment", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain('const PREFIX_ADAPTER_APP_ID = "649fbb98-07b3-4cbd-a7ed-3e3d224dca87"');
    expect(main).toContain("async collectPrefixAdapterSamples(appId)");
    expect(main).toContain("last_ai_reply: String(record.answer)");
    expect(main).toContain("samples.length < PREFIX_ADAPTER_MAX_SAMPLES");
    expect(main).toContain("isExcludedPrefixAdapterSample(sample.last_ai_reply)");
    expect(main).toContain("formatPrefixAdapterRequest({");
    expect(main).toContain("await this.runPrefixAdapterModel(request)");
    expect(main).not.toContain("this.runPrefixAdapterModel(JSON.stringify(request))");
    expect(main).toContain('event: "clean-conversation-ready"');
    expect(main).toContain("questionCount === 0 && answerCount === 0");
    expect(main).toContain("parsePrefixAdapterSuggestion(generated?.output)");
    expect(main).toContain("adapterConversationId:");
    expect(main).toContain('event: "response-received"');
    expect(main).toContain("latest.adapters[appId] = record");
    expect(main).toContain("upsertPerspectivePrefix(source, false), members, prefixAdapter");
    expect(main).toContain('handleLocalIpc("backend:adapt-work-prefix"');
    expect(preload).toContain('adaptWorkPrefix: () => ipcRenderer.invoke("backend:adapt-work-prefix")');
    expect(renderer).toContain("await api.adaptWorkPrefix()");
    expect(html).toContain('id="prefix-adapter-card"');
    expect(html).toContain("需要消耗积分");
  });

  it("keeps plugin entries visible in their groups and collapsed by default", () => {
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(html).toMatch(/<details class="plugin-card plugin-disclosure" id="effect-judge-card">/);
    expect(html).toMatch(/<details id="prefix-adapter-card" class="conversation-card plugin-disclosure">/);
    expect(html).toContain("联机前置词适配");
    expect(html).toContain('id="prefix-adapter-summary-state">等待选择作品</em>');
    expect(html).toMatch(/<summary class="plugin-summary"><span class="plugin-summary-main"><label class="plugin-summary-toggle"[^>]*><input id="effect-judge-enabled"/);
    expect(html.match(/id="effect-judge-enabled"/g)).toHaveLength(1);
    expect(renderer).not.toContain('adapterCard.classList.toggle("hidden",!next.work)');
    expect(renderer).toContain('adapterButton.textContent=!next.work?"请先选择作品"');
    expect(renderer).toContain('if(next.work&&["adapting","error"].includes(adapter?.status))adapterCard.open=true');
    expect(renderer).toContain('effectJudgeToggle.closest(".plugin-summary-toggle").addEventListener("click",event=>event.stopPropagation())');
    expect(renderer).toContain('await api.updatePluginSettings("effect-judge",{enabled})');
  });

  it("provides a home page and persistent multi-character profiles", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain('"character-profiles"');
    expect(main).toContain('handleLocalIpc("profiles:save"');
    expect(html).toContain('id="home-page"');
    expect(html).toContain('id="profiles-page"');
    expect(html).toContain('id="profile-editor-basic-info"');
    expect(html).toContain('id="profile-editor-appearance"');
    expect(main).toContain("item?.basicInfo ?? item?.info");
    expect(main).toContain("version: 2");
  });

  it("uses a full-size native WebContentsView with the real message DOM as its stage", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain("this.liveGameSurface = true");
    expect(main).toContain("this.window.contentView.addChildView(this.gameSurface)");
    expect(main).toContain("this.gameSurface.setBounds(this.backgroundWindowBounds())");
    expect(main).toContain("hiddenWindow.webContents.setFrameRate(30)");
    expect(main).toContain("this.gameFrameTimer = this.liveGameSurface ? null");
    expect(main).not.toContain("gameContainerBounds() {");
    expect(main).not.toContain("gameViewportBounds() {");
    expect(main).toContain('html[data-fy-surface="game"] [data-fymp-message-stage]');
    expect(main).toContain("z-index: 2147483646 !important");
    expect(main).toContain("const findMessageStage = chat =>");
    expect(main).toContain("const lowestCommonAncestor = nodes =>");
    expect(main).toContain("const markStagePath = stage =>");
    expect(main).toContain("const markMessageBranches = (stage,targets) =>");
    expect(main).toContain("data-fymp-stage-path");
    expect(main).toContain("data-fymp-stage-sibling");
    expect(main).toContain("data-fymp-message-stage");
    expect(main).toContain("data-fymp-message-sibling");
    expect(main).toContain('html[data-fy-surface="game"] [data-fymp-stage-sibling]');
    expect(main).toContain("display: contents !important");
    expect(main).toContain("#customized-question-content,#ai-chat-answer");
    expect(main).not.toContain("shieldTransparentHitLayers");
    expect(main).not.toContain("data-fymp-transparent-hit-layer");
    expect(main).not.toContain("data-fymp-transparent-pseudo-layer");
    expect(main).not.toContain("interactionShield");
    expect(main).toContain("pointer-events: none !important");
    expect(main).not.toContain("body * {");
    expect(main).not.toContain('html[data-fy-surface="game"] [data-fy-game-sibling]');
    expect(main).not.toContain("const markChatPath = chat =>");
    expect(main).toContain("window.__fympGameObserver.observe(document.body");
    expect(main).toContain("host.attachShadow({mode:'closed'})");
    expect(main).toContain("crypto.getRandomValues(values)");
    expect(main).toContain("host.dataset.fympToolPhase = 'before-model'");
    expect(main).toContain("window.__fympToolResults");
    expect(main).toContain("fymp:tool-resolved");
    expect(main).toContain("currentQuestionRow.parentElement.insertBefore(host,currentAnswerRow)");
    expect(preload).toContain('injectPrototypeToolCard: () => ipcRenderer.invoke("backend:inject-prototype-tool-card")');
    expect(renderer).not.toContain("await api.injectPrototypeToolCard()");
    expect(html).not.toContain('id="live-view-experiment"');
  });

  it("runs enabled conversation plugins as fail-open input and output stacks", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain('const EFFECT_JUDGE_APP_ID = "8769d311-9a37-48e0-9b19-caf7590c6f15"');
    expect(main).toContain("runConversationPluginStack(PLUGIN_PHASES.INPUT");
    expect(main).toContain("runConversationPluginStack(PLUGIN_PHASES.OUTPUT");
    expect(main).toContain('activeRound.status = "processing-input"');
    expect(main).toContain('activeRound.status = "processing-output"');
    expect(main).toContain("pluginRuns: activeRound.pluginRuns");
    expect(main).toContain("crypto.randomInt(1, settings.dieFaces + 1)");
    expect(main).toContain("mapEffectDegreesToFaces(player.degrees, settings.dieFaces)");
    expect(main).toContain("const renderedAnswer = answer.cloneNode(true)");
    expect(main).toContain("const renderedOutput = String(renderedAnswer.textContent || '')");
    expect(main).toContain("stableReads >= 2");
    expect(main).toContain("outputSource: editorOutput.trim() ? 'editor' : 'rendered'");
    expect(preload).toContain('updatePluginSettings: (pluginId, settings)');
    expect(renderer).toContain('api.updatePluginSettings("effect-judge",payload)');
    expect(html).toContain('data-tab="plugins"');
    expect(html).not.toContain('id="effect-judge-results"');
    expect(html).toMatch(/id="effect-judge-degrees" type="number" min="4" max="8" value="4"/);
    expect(html).toMatch(/id="effect-judge-faces" type="number" min="6" max="20" value="10"/);
    expect(renderer).toContain("degreeCount>dieFaces-2");
    expect(renderer).toContain('definition.enabled&&!contextAvailable?"等待上文"');
    expect(main).toContain('skipReason: "no-history"');
    expect(main).toContain("async injectConversationPluginCards");
    expect(main).toContain("Array.isArray(runs) ? runs : Array.isArray(pluginRuns) ? pluginRuns : []");
    expect(main).toContain("host.dataset.fympToolPhase = run.phase");
    expect(main).toContain("parent.insertBefore(entry.host,cursor.nextSibling)");
    expect(main).toContain("await this.injectConversationPluginCards({ round, input, runs: this.room.round.pluginRuns })");
    expect(html).toContain("每轮会额外调用一次平台作品，需要消耗一定积分");
  });

  it("routes message operations through an unobscured confirmation and the output plugin stack", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(renderer).not.toContain("window.confirm(");
    expect(renderer).toContain('confirmAction("刷新会调用房主平台模型并可能消耗积分');
    expect(renderer).toContain('confirmAction("确定删除所有成员的最近一条 AI 回复');
    expect(html).not.toContain('id="confirm-overlay"');
    expect(main).toContain("const findMessageButton = (target, selector)");
    expect(main).toContain("const chooser = [...document.querySelectorAll");
    expect(main).toContain("const operationRound = {");
    expect(main).toContain("await this.runConversationPluginStack(");
    expect(main).toContain("Array.isArray(previousResult.pluginRuns)");
  });

  it("keeps the platform message-operation page script syntactically valid", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const methodStart = main.indexOf("  async performLatestPlatformMessageOperation");
    const methodEnd = main.indexOf("  async syncGuestMessageOperation", methodStart);
    const method = main.slice(methodStart, methodEnd);
    const scriptStart = method.indexOf("executeJavaScript(`") + "executeJavaScript(`".length;
    const scriptEnd = method.indexOf("`, true)", scriptStart);
    const pageTemplate = method.slice(scriptStart, scriptEnd);
    const cookedPageScript = new Function("JSON", "operation", "expectedOutput", `return \`${pageTemplate}\`;`)(JSON, "refresh", "");
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    expect(() => new Function(cookedPageScript)).not.toThrow();
  });

  it("keeps the conversation plugin card page script syntactically valid", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const methodStart = main.indexOf("  async injectConversationPluginCards");
    const methodEnd = main.indexOf("  async showIntro", methodStart);
    const method = main.slice(methodStart, methodEnd);
    const scriptStart = method.indexOf("executeJavaScript(`") + "executeJavaScript(`".length;
    const scriptEnd = method.lastIndexOf("`, true)");
    const pageTemplate = method.slice(scriptStart, scriptEnd);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(scriptStart).toBeGreaterThan("executeJavaScript(`".length);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    const cookedPageScript = new Function(
      "JSON",
      "roundNumber",
      "expectedInput",
      "cards",
      "EFFECT_JUDGE_PLUGIN_ID",
      "PERSPECTIVE_PLUGIN_ID",
      `return \`${pageTemplate}\`;`
    )(JSON, 2, '{"Users":[]}', [], "effect-judge", "perspective-split");
    expect(() => new Function(cookedPageScript)).not.toThrow();
    expect(method).toContain("replace(/\\\\r\\\\n/g,'\\\\n')");
    expect(method).toContain("lastAnchorMatch = 'whitespace-normalized'");
    expect(method).toContain("lastAnchorMatch = 'latest-question'");
  });

  it("shows a plain-language live flow message above the round send button", () => {
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../electron/desktop/styles.css", import.meta.url), "utf8");
    const theme = readFileSync(new URL("../electron/desktop/theme.css", import.meta.url), "utf8");
    expect(html).toMatch(/id="round-flow-status"[^>]*role="status"/);
    expect(html).toMatch(/id="submit-round"[^>]*>[^<]*<\/button><small id="round-flow-status"/);
    expect(renderer).toContain("function activeConversationFlow(next)");
    expect(renderer).toContain('"正在准备本轮回复"');
    expect(renderer).toContain('"正在生成对话内容"');
    expect(renderer).toContain('flowStatus.classList.toggle("hidden",!flowCopy)');
    expect(styles).toContain(".round-flow-status{");
    expect(styles).not.toMatch(/\.round-flow-status\{[^}]*border/);
    expect(theme).toMatch(/\.round-flow-status\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(100% \+ 6px\)/);
  });

  it("opens every selected work on a fresh blank conversation", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const start = main.indexOf("  async prepareWorkSurfaces()");
    const end = main.indexOf("  async prepareGuestIntroSurface()", start);
    const method = main.slice(start, end);
    expect(method).toContain("await mountedTask");
    expect(method).toContain("await this.createBlankPlatformConversation()");
    expect(method).toContain('this.adoptPendingConversation(created, sessionKey, "host")');
    expect(method).toContain('event: "work-opened-with-blank-conversation"');
    expect(method.indexOf("await this.createBlankPlatformConversation()"))
      .toBeLessThan(method.indexOf("this.adoptPendingConversation(created, sessionKey"));
  });

  it("keeps guest round-result synchronization edit-only in the live view", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const syncStart = main.indexOf("async syncGuestRoundResult(result");
    const syncEnd = main.indexOf("async syncGuestRoundResultWithRetries", syncStart);
    const activeSync = main.slice(syncStart, syncEnd);
    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(activeSync).toContain('event: "prepared-input-verification"');
    expect(activeSync).toContain("#customized-edit-button");
    expect(activeSync).toContain("HTMLElement.prototype.click.call(save)");
    expect(activeSync).toContain("round-result 不会再次发送输入");
    expect(activeSync).not.toContain("readySend.click()");
    expect(activeSync).not.toContain("retrySend.click()");
    expect(activeSync).not.toContain("#ai-send-button').click");
  });

  it("stops guest generation before conversation discovery and keeps fast output editable", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const prepareStart = main.indexOf("async prepareGuestRoundInput(payload");
    const prepareEnd = main.indexOf("async prepareGuestRoundInputWithRetries", prepareStart);
    const prepare = main.slice(prepareStart, prepareEnd);
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(prepare.indexOf("mark('stop-control-found-immediately')"))
      .toBeLessThan(prepare.indexOf("const postStopDeadline"));
    expect(prepare).toContain("for (let burst = 1; burst <= 5; burst += 1)");
    expect(prepare).toContain("[20,60,120,240,480,720].includes(attempt)");
    expect(prepare).toContain("mark('late-stop-clicked',{confirmation})");
    expect(prepare).toContain("roundState.terminationMode = 'completed-before-stop'");
    expect(prepare).toContain("成员端已经停止生成，但平台没有返回会话编号；不会重复发送本轮输入");
  });

  it("keeps the dialogue view resident under a native settings overlay", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const theme = readFileSync(new URL("../electron/desktop/theme.css", import.meta.url), "utf8");
    expect(main).toContain("async ensureSettingsSurface()");
    expect(main).toContain('query: { settingsOverlay: "1" }');
    expect(main).toContain("this.window.contentView.addChildView(view)");
    expect(main).toContain("return this.gameFrameModeVisible() && this.gameSurfacePresentationLocks === 0");
    expect(main).toContain('["loading-game", "game", "game-empty"].includes(this.mode)');
    expect(main).toContain('!this.guestOutputPending()');
    expect(main).toContain("if (this.gameSurfaceShouldPresent() && this.activeSurface)");
    expect(main).toContain("await this.publishLiveGameSnapshot()");
    expect(renderer).toContain('get("settingsOverlay") === "1"');
    expect(theme).toContain("body.settings-overlay-mode .settings-popover");
  });

  it("temporarily removes live-view privacy CSS while platform edit dialogs are open", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const clearStart = main.indexOf("async clearGameIsolation()");
    const clearEnd = main.indexOf("async setPlatformConversationId", clearStart);
    const clear = main.slice(clearStart, clearEnd);
    expect(clear).toContain("await this.gamePrivacyCssPromise.catch");
    expect(clear).toContain("removeInsertedCSS(this.gamePrivacyCssKey)");
    expect(main).toContain("this.gameSurfacePresentationLocks = 0");
    expect(main).toContain("this.suspendGameSurfacePresentation()");
    expect(main).toContain("this.resumeGameSurfacePresentation()");
    expect(main).toContain("this.gameSurfaceShouldPresent()");
  });

  it("keeps every tool entry behind the home-page login gate", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const homeStart = html.indexOf('id="home-page"');
    const multiplayerStart = html.indexOf('id="multiplayer-page"');
    const loginStart = html.indexOf('id="login-panel"');
    expect(homeStart).toBeGreaterThanOrEqual(0);
    expect(loginStart).toBeGreaterThan(homeStart);
    expect(loginStart).toBeLessThan(multiplayerStart);
    expect(renderer).toContain('if(requiresLogin&&activePage!=="home")showPage("home")');
    expect(main).toContain('throw new Error("请先在主页面登录风月账号")');
  });

  it("keeps logs and isolated instances behind the exact administrator email", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain('const ADMIN_EMAIL = "8zhua@test.com"');
    expect(main).toMatch(/isAdminAccount\(\)[\s\S]*this\.account\?\.email[\s\S]*ADMIN_EMAIL/);
    expect(main).toMatch(/getSessionLogs\(\)[\s\S]*this\.assertAdminAccount\(\)/);
    expect(main).toMatch(/backend:new-instance[\s\S]*backend\.assertAdminAccount\(\)/);
    expect(main).toContain('if (this.isAdminAccount() && !this.window.isDestroyed()) this.window.webContents.send("backend:log", entry)');
    expect(html.match(/data-admin-only/g)?.length).toBeGreaterThanOrEqual(4);
    expect(renderer).toContain('document.querySelectorAll("[data-admin-only]")');
    expect(renderer).toContain('if(state?.isAdmin)receiveSessionLog(entry)');
  });

  it("launches packaged account instances from a real executable directory instead of the ASAR path", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const start = main.indexOf("function safeProfileId");
    const end = main.indexOf("function selectedOriginPath", start);
    const launchSpec = new Function("path", "app", "process", "PROJECT_ROOT", `${main.slice(start, end)}; return instanceLaunchSpec;`)(
      path, { isPackaged: true }, { execPath: "ignored" }, "ignored"
    );
    const executable = "C:\\Users\\tester\\AppData\\Local\\Programs\\fengyue-link\\风月联机工具.exe";
    const packaged = launchSpec("player 2", true, executable, "C:\\virtual\\resources\\app.asar");
    expect(packaged).toEqual({
      command: executable,
      args: ["--profile=player-2"],
      cwd: path.dirname(executable)
    });
    expect(packaged.cwd).not.toContain("app.asar");
    expect(launchSpec("host", false, executable, "D:\\mirror")).toEqual({
      command: executable,
      args: ["D:\\mirror", "--profile=host"],
      cwd: "D:\\mirror"
    });
    expect(main).toContain("const launch = instanceLaunchSpec(id)");
    expect(main).toContain("cwd: launch.cwd");
  });

  it("routes room chat through the host and broadcasts each canonical append immediately", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).toContain('makePacket("room-chat-submit"');
    expect(main).toContain('const clientSentAtIso = new Date(clientSentAt).toISOString()');
    expect(main).toContain('clientSentAt: packet.payload?.clientSentAt');
    expect(main).toContain('clientSentAtIso: packet.payload?.clientSentAtIso');
    expect(main).toContain('sort((left, right) => this.compareRoomChatMessages(left, right))');
    expect(main).toMatch(/compareRoomChatMessages\(left, right\)[\s\S]*left\?\.sentAt[\s\S]*left\?\.id/);
    expect(main).toContain('"room-chat-append"');
    expect(main).toContain('this.queueRoomChatBroadcast(message)');
    expect(main).toContain('await this.broadcastPendingRoomChatMessages()');
    expect(main).toContain('makePacket("room-chat-sync-request"');
    expect(main).toContain('await this.sendLargeRoomPacket(chatId, "room-chat-sync", this.room.id, this.roomChatPayload())');
    expect(main).toContain('String(message.clientMessageId) === stableClientId');
    expect(main).toContain('messages: this.roomChatVisibleMessages()');
    expect(main).toContain('id: `local:${stableClientId}`');
    expect(main).toContain('optimistic: true');
    expect(main).toMatch(/roomChatVisibleMessages\(\)[\s\S]*hasCanonicalMessage[\s\S]*compareRoomChatMessages/);
    expect(main).toContain('envelopes.sort((left, right) => left.receivedAt - right.receivedAt');
    expect(main).toContain('handleLocalIpc("backend:send-room-chat"');
    expect(preload).toContain('sendRoomChat: value => ipcRenderer.invoke("backend:send-room-chat", value)');
    expect(renderer).toContain('api.sendRoomChat(text)');
    expect(renderer).toContain('card.classList.toggle("pending",Boolean(message.optimistic))');
    expect(renderer).toContain('pendingId!==renderedRoomChatPendingId');
    expect(renderer).toContain('"发送中…"');
    expect(renderer).not.toContain('等待房主确认并回传');
    expect(renderer).not.toContain('检测到聊天消息缺口');
    expect(renderer).toContain('status.classList.toggle("hidden",!status.textContent)');
    expect(html).toContain('id="room-chat-messages"');
    expect(html).toContain('id="room-chat-form"');
  });

  it("keeps the simplified shell, themed prompts, attention cues, and scrollbars in the desktop UI", () => {
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../electron/desktop/styles.css", import.meta.url), "utf8");
    const loginStyles = readFileSync(new URL("../electron/desktop/login.css", import.meta.url), "utf8");
    const theme = readFileSync(new URL("../electron/desktop/theme.css", import.meta.url), "utf8");
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(html).toContain('class="feature-card primary"');
    expect(html).not.toContain('id="confirm-overlay"');
    expect(html).toContain('id="member-tip-stack"');
    expect(html).toContain('id="work-selector-tip"');
    expect(html).toContain("请选择想要游玩的作品");
    expect(html).not.toContain('<span aria-hidden="true">选</span>');
    expect(html).toContain('id="settings-toggle"');
    expect(html).toContain('id="settings-popover"');
    expect(html).toContain('id="settings-domain-list"');
    expect(html).toContain('id="settings-logout"');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    expect(html).not.toContain('id="theme-toggle"');
    expect(html).not.toContain("<span>联</span>");
    expect(html).not.toContain("<span>设</span>");
    expect(html).not.toContain("<span>介</span>");
    expect(html).not.toContain("<span>话</span>");
    expect(html).not.toContain('<span class="modal-icon">!</span>');
    expect(html.lastIndexOf('href="theme.css"')).toBeGreaterThan(html.lastIndexOf('href="game-frame.css"'));
    expect(html).not.toContain("Windows 加密凭据");
    expect(html).not.toContain("返回纯工具页面");
    expect(html).not.toContain("成员将自动验证并加入，无需房主操作");
    expect(renderer).toContain("confirmAction(");
    expect(renderer).toContain("conversationAttentionKey");
    expect(renderer).toContain("showMemberJoinedTip");
    expect(renderer).toContain("playMemberJoinSound");
    expect(renderer).toContain('next.mode!=="selector"');
    expect(renderer).toContain('localStorage.setItem(UI_THEME_STORAGE_KEY,theme)');
    expect(renderer).toContain('api.setTheme(theme)');
    expect(renderer).toContain("await api.switchOrigin(item.origin)");
    expect(renderer).toContain("const next=await api.logout()");
    expect(renderer).toContain("await api.setSettingsVisible(true)");
    expect(styles).toContain("::-webkit-scrollbar-thumb");
    expect(styles).toContain("@keyframes conversation-attention");
    expect(loginStyles).toContain(".member-remove");
    expect(theme).toContain(':root[data-theme="light"]');
    expect(theme).toContain(':root[data-theme="dark"]');
    expect(theme).toMatch(/body \*[\s\S]*?border:\s*0 !important/);
    expect(theme).toMatch(/background-image:\s*none !important/);
    expect(theme).toContain("--canvas: #f7f1e7");
    expect(theme).toContain("--panel-flat: #fffaf2");
    expect(theme).toContain("--accent-flat: #d88952");
    expect(theme).toContain(".settings-popover");
    expect(theme).toMatch(/#app-version\s*\{[\s\S]*?border-right:\s*0 !important/);
    expect(theme).not.toContain("--canvas: #edf3f1");
    expect(main).toContain('theme === "light" ? "#f7f1e7"');
    expect(main).toContain("--surface:#f3e4d2;--control:#ead5bd");
    expect(html.match(/assets\/cat-pumpkin-logo\.png/g)).toHaveLength(7);
    expect(html).not.toContain('<span class="landing-logo">联</span>');
    expect(loginStyles).toContain(".login-brand img");
    expect(theme).toMatch(/img\.logo,[\s\S]*?background:\s*transparent !important/);
    expect(html).toMatch(/<header class="topbar">[\s\S]*id="back-home"[\s\S]*id="show-intro"[\s\S]*id="show-game"/);
    expect(html.match(/<header class="brand">[\s\S]*?<\/header>/)?.[0]).not.toContain('id="back-home"');
    expect(styles).toContain(".topbar-surface-switcher");
    expect(renderer).toContain("返回主页将解散当前房间");
    expect(renderer).toContain("await api.leaveRoom()");
    expect(existsSync(new URL("../electron/desktop/assets/cat-pumpkin-logo.png", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../build/cat-pumpkin-logo.ico", import.meta.url))).toBe(true);
    expect(packageManifest.build.win.icon).toBe("build/cat-pumpkin-logo.ico");
    expect(main).toContain('handleLocalIpc("backend:set-theme"');
    expect(main).toContain('handleLocalIpc("backend:switch-origin"');
    expect(main).toContain('handleLocalIpc("backend:logout"');
    expect(main).toContain('handleLocalIpc("backend:set-settings-visible"');
  });

  it("supports revisioned member joins and host removal with prompt refresh", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    expect(main).toContain("async removeRoomMember(memberId)");
    expect(main).toContain('makePacket("member-joined"');
    expect(main).toContain('makePacket("member-removed"');
    expect(main).toContain("removedMemberIds: new Set()");
    expect(main).toContain("this.room.rosterRevision");
    expect(main).toContain("await this.syncHostMultiplayerConversationConfig(4)");
    expect(main).toContain('handleLocalIpc("backend:remove-room-member"');
    expect(preload).toContain('removeRoomMember: memberId => ipcRenderer.invoke("backend:remove-room-member", memberId)');
    expect(renderer).toContain("await api.removeRoomMember(member.id)");
    expect(renderer).toContain("expandedMemberAppearances");
  });

  it("shows author information and opens only configured allowlisted destinations", () => {
    const authorInfo = readFileSync(new URL("../electron/author-info.cjs", import.meta.url), "utf8");
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(authorInfo).toContain('const AUTHOR_NAME = "八爪毛米"');
    expect(authorInfo).toContain('homepage: "https://staging.aiero.cc/zh/profile/39404f0e-7678-45a1-86c6-9a21116bacbd"');
    expect(authorInfo).toContain('github: "https://github.com/pumpcatkin/fengyue-link/releases/latest"');
    expect(authorInfo).toContain('if (url.protocol !== "https:")');
    expect(main).toContain('handleLocalIpc("app:get-author-info", () => publicAuthorInfo())');
    expect(main).toContain('shell.openExternal(configuredAuthorUrl(key))');
    expect(preload).toContain('getAuthorInfo: () => ipcRenderer.invoke("app:get-author-info")');
    expect(preload).toContain('openAuthorLink: key => ipcRenderer.invoke("app:open-author-link", key)');
    expect(renderer).toContain("function renderAuthorInfo(info)");
    expect(renderer).toContain("api.openAuthorLink(button.dataset.authorLink)");
    expect(html).toContain('id="author-name">八爪毛米');
    expect(html).toContain('<small>关于</small>');
    expect(html).not.toContain('id="profile-label"');
    expect(html).toContain('id="online-world-library-list"');
    expect(html).not.toContain('id="online-world-featured"');
    for (const key of ["homepage", "releasePost", "feedbackPost", "github"]) {
      expect(html).toContain(`data-author-link="${key}"`);
    }
  });

  it("broadcasts host room dissolution and clears authenticated guests", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    expect(main).toContain('makePacket("room-closed"');
    expect(main).toContain("解散通知未能发送给所有访客，房间暂未解散");
    expect(main).toContain('packet.type === "room-closed"');
    expect(main).toContain("String(chatId) !== String(this.room.hostChatId)");
    expect(main).toContain("this.clearRoomSession({ roomClosed:");
    expect(renderer).toContain("if(next.roomClosed)toast(");
    expect(renderer).toContain('next.room.role==="host"?"解散当前房间"');
  });

  it("keeps a self-contained, low-context authoring entry point for new multiplayer plugins", () => {
    const guide = readFileSync(new URL("../docs/plugin-authoring-guide.md", import.meta.url), "utf8");
    const handoff = readFileSync(new URL("../docs/project-handoff.md", import.meta.url), "utf8");
    expect(guide).toContain("runPlatformAutomationModel(appId, modelInput, label)");
    expect(guide).toContain("runConversationPluginStack()");
    expect(guide).toContain("normalizePluginSettings");
    expect(guide).toContain("房主权威执行流程");
    expect(guide).toContain("本地 Markdown 不会被发送给平台插件作品");
    expect(guide).toContain("所有插件默认关闭");
    expect(guide).toContain("第二个正式插件加入前");
    expect(handoff).toContain("插件专项新对话只需先完整阅读 `docs/plugin-authoring-guide.md`");
    expect(existsSync(new URL("../README.md", import.meta.url))).toBe(false);
  });

  it("exposes the packaged app version and keeps the official installer identity stable", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(packageJson.version).toMatch(/^\d+\.\d+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
    expect(packageJson.devDependencies.electron).toBe("^44.0.0");
    expect(packageJson.name).toBe("fengyue-link");
    expect(packageJson.build.appId).toBe("cc.aiero.fengyue.link");
    expect(packageJson.build.productName).toBe("风月联机工具");
    expect(packageJson.build.electronVersion).toBe("44.0.0");
    expect(packageJson.build.win.icon).toBe("build/cat-pumpkin-logo.ico");
    expect(packageJson.build.nsis.guid).toBe("63340c0b-8899-4ec0-9aa3-5a80da4ed183");
    expect(packageJson.build.nsis.include).toBe("build/installer.nsh");
    expect(packageJson.build.nsis.oneClick).toBe(false);
    expect(packageJson.build.nsis.allowToChangeInstallationDirectory).toBe(true);
    expect(packageJson.build.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(packageJson.build.nsis.createDesktopShortcut).toBe("always");
    expect(packageJson.build.nsis.uninstallDisplayName).toBe("风月联机工具");
    const installerInclude = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
    expect(installerInclude).toContain('!macro customCheckAppRunning');
    expect(installerInclude).toContain('${IfNot} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(installerInclude).toContain('${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}"');
    expect(installerInclude).not.toContain("Path.StartsWith");
    expect(main).toContain('handleLocalIpc("app:get-version", () => app.getVersion())');
    expect(main).toContain('handleLocalIpc("app:get-release-channel", () => RELEASE_CHANNEL)');
    expect(main).toContain("app.setAppUserModelId(APPLICATION_ID)");
    expect(preload).toContain('getAppVersion: () => ipcRenderer.invoke("app:get-version")');
    expect(preload).toContain('getReleaseChannel: () => ipcRenderer.invoke("app:get-release-channel")');
    expect(renderer).toContain("api.getAppVersion()");
    expect(html).toContain('id="app-version"');
    expect(html).toContain(`v${packageJson.version}`);
  });

  it("mutes the resident introduction outside the visible tool surface and closes every owned surface on exit", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain("setIntroAudioMuted(muted)");
    expect(main).toContain("webContents.setAudioMuted(Boolean(muted))");
    expect(main).toContain("this.setIntroAudioMuted(view !== this.introSurface)");
    expect(main).toContain("this.setIntroAudioMuted(true)");
    expect(main).toContain("closePlatformView(view)");
    expect(main).toContain("stopSpawnedInstanceProcesses();");
    expect(main).toContain('app.on("before-quit"');
    expect(main).toContain("for (const window of BrowserWindow.getAllWindows())");
  });

  it("revalidates the two token-relevant files on every hidden packaged startup and shows only branded result dialogs", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    const releaseSecurity = readFileSync(new URL("../electron/release-security.cjs", import.meta.url), "utf8");
    expect(main).toContain("new ReleaseSecurityGate({");
    expect(main).toContain("await this.releaseSecurity.initialize()");
    expect(main.match(/this\.verifyOfficialRelease\(\)/g)).toHaveLength(2);
    expect(main).toContain("await waitForLoginTask(this.verifyOfficialRelease(), controller.signal)");
    expect(main).not.toContain("showStartupAnnouncement");
    expect(main).not.toContain('handleLocalIpc("app:verify-official-release"');
    expect(main).toContain('handleLocalIpc("app:open-official-release-page"');
    expect(main).toContain('handleLocalIpc("app:check-for-updates"');
    expect(main).toContain('handleLocalIpc("app:request-update"');
    expect(main).toContain('handleLocalIpc("app:quit"');
    expect(preload).not.toContain("verifyOfficialRelease");
    expect(preload).toContain('openOfficialReleasePage: () => ipcRenderer.invoke("app:open-official-release-page")');
    expect(preload).toContain('checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates")');
    expect(preload).toContain('requestAppUpdate: () => ipcRenderer.invoke("app:request-update")');
    expect(preload).toContain('quitApp: () => ipcRenderer.invoke("app:quit")');
    expect(renderer).toContain("showStartupOfficialNotice()");
    expect(renderer).toContain("renderUpdateSettings(security,update)");
    expect(renderer).toContain("showReleaseVerificationStatus(security,update)");
    expect(renderer).toContain("? await api.requestAppUpdate()");
    expect(renderer).toContain(": await api.checkForUpdates()");
    expect(renderer).not.toContain("verifyOfficialRelease");
    expect(html).not.toContain('id="release-security-card"');
    expect(html).toContain('id="official-notice-overlay"');
    expect(html).toContain("正在获取最新版本信息");
    expect(html).toContain("github.com/pumpcatkin/fengyue-link/releases/latest");
    expect(html).toContain('id="official-notice-open" type="button">检查最新版本</button>');
    expect(html).toContain('id="settings-update-action" type="button">检查最新版本</button>');
    expect(html).not.toMatch(/公钥|指纹/);
    expect(html).toContain(`v${packageJson.version}`);
    expect(releaseSecurity).toContain('const OFFICIAL_REPOSITORY = "pumpcatkin/fengyue-link"');
    expect(releaseSecurity).toContain("crypto.verify(null, bytes, publicKey, signature)");
    expect(releaseSecurity).toContain('path.join(this.resourcesPath, "app.asar")');
    expect(releaseSecurity).toContain("const NETWORK_TIMEOUT_MS = 30000");
    expect(releaseSecurity).toContain("const NETWORK_RETRY_ATTEMPTS = 3");
    expect(releaseSecurity).toContain("LATEST_MANIFEST_URL");
    expect(releaseSecurity).toContain("LATEST_SIGNATURE_URL");
    expect(releaseSecurity).not.toContain("this.fetch(LATEST_RELEASE_API");
    expect(releaseSecurity).toContain("const deadlineAt = Date.now() + this.networkTimeoutMs");
    expect(releaseSecurity).toContain('physicalFs = require("original-fs")');
    expect(releaseSecurity).toContain("physicalFs.createReadStream(file");
    expect(releaseSecurity).toContain("const RUNTIME_INTEGRITY_FILE_COUNT = 2");
    expect(releaseSecurity).toContain("initializeStartupVerification()");
    expect(releaseSecurity).toContain('source: "bundled-signed-runtime-proof"');
    expect(releaseSecurity).toContain("readBundledRuntimeProof()");
    expect(packageJson.scripts["release:runtime-proof"]).toContain("create-runtime-proof.cjs");
    expect(releaseSecurity).not.toContain("attempt.json");
    expect(releaseSecurity).not.toContain("refreshInBackground");
    expect(releaseSecurity).not.toContain("verifyCached");
    expect(releaseSecurity).not.toContain("keyFingerprint:");
    expect(main).toContain("executablePath: process.execPath");
    expect(releaseSecurity).not.toContain("PRIVATE KEY");
    expect(packageJson.scripts["release:manifest"]).toContain("create-release-manifest.cjs");
    expect(packageJson.scripts["verify:electron-fuses"]).toContain("verify-electron-fuses.cjs");
    expect(packageJson.dependencies["electron-updater"]).toBe("^6.8.9");
    expect(packageJson.build.electronFuses).toMatchObject({
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false
    });
    expect(packageJson.build.publish).toEqual([expect.objectContaining({ provider: "github", owner: "pumpcatkin", repo: "fengyue-link" })]);
    expect(packageJson.build.win.artifactName).toBe("fengyue-link-${version}-setup.${ext}");
    expect(main).toContain("new OfficialUpdateService({");
    expect(main).toContain("void this.updateService.start()");
  });

  it("sandboxes local pages and rejects untrusted IPC senders and navigation", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
    expect(main).not.toContain("sandbox: false");
    expect(main).toContain("function isTrustedDesktopSender(event)");
    expect(main).toContain("if (!isTrustedDesktopSender(event))");
    expect(main).toContain("guardDesktopNavigation(mainWindow.webContents)");
    expect(html).toContain("Content-Security-Policy");
    expect(main).not.toContain('ipcMain.handle("fy:fetch-text"');
    expect(main).not.toContain("async addChatChannel(channel)");
  });

  it("uses compatible strong room authentication and binds members to platform chats", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain("function derivePasswordVerifierV2");
    expect(main).toContain('authSchemes: ["scrypt-v2", "sha256-v1"]');
    expect(main).toContain('packet.payload?.authScheme === "scrypt-v2"');
    expect(main).toContain('const remoteAccountId = String(context.chat?.other_account?.id || "").trim()');
    expect(main).toContain("JSON.stringify(profile) !== JSON.stringify(pending.profile)");
    expect(main).toContain("!expectedChatId || String(expectedChatId) !== String(chatId)");
    expect(main).toContain('code: "VERSION_MISMATCH"');
    expect(main).toContain('appVersion: this.appVersion');
    expect(main).toContain("请在访客端更新风月联机工具");
  });

  it("fully releases the isolated platform connectivity verifier", () => {
    const verifier = readFileSync(new URL("../scripts/verify-platform-connectivity.cjs", import.meta.url), "utf8");
    expect(verifier).toContain("reader?.close()");
    expect(verifier).toContain("instance.anchor.destroy()");
    expect(verifier).toContain("await partition.clearStorageData()");
  });
});
