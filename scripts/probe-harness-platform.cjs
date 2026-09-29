// Read official frontend assets and run only disposable attachment/model probes.
// Existing encrypted credentials are decrypted in memory; never log them.
const { app, BrowserWindow, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const root = path.resolve(__dirname, "..");
const originalData = path.join(app.getPath("appData"), "风月联机工具");
const output = path.join(root, "output/harness-platform");
app.setPath("userData", originalData);
app.on("window-all-closed", () => {});
const source = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const loaded = new Module(path.join(root, "electron/harness-probe.cjs"), module);
loaded.filename = path.join(root, "electron/harness-probe.cjs");
loaded.paths = Module._nodeModulePaths(path.join(root, "electron"));
loaded._compile(source.slice(0, source.indexOf("let mainWindow;")) + "\nmodule.exports={AccountBackend};", loaded.filename);
app.whenReady().then(async () => {
  let backend, window, resultCode = 0;
  const report = { discovered: [], models: [] };
  const liveProbe = process.argv.includes("--live") || process.argv.some(arg => arg.startsWith("--repair-candidate="));
  const timeout = setTimeout(() => {
    resultCode = 1;
    console.error("Probe deadline reached; cancelling active requests");
    if (backend?.editorHarnessController) backend.editorHarnessController.abort();
    else { backend?.destroy(); app.exit(1); }
  }, liveProbe ? 1200000 : 180000);
  try {
    const profile = process.env.FYMP_QA_PROFILE || "default";
    const credentialFile = path.join(originalData, "credentials", `${profile}.json`);
    const encrypted = JSON.parse(fs.readFileSync(credentialFile, "utf8")).encrypted;
    const credentials = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
    const selection = JSON.parse(fs.readFileSync(path.join(originalData, "node-selections", `${profile}.json`), "utf8"));
    app.setPath("userData", path.join(output, "profile"));
    window = new BrowserWindow({ show: false });
    backend = new loaded.exports.AccountBackend(window, "harness-probe");
    backend.releaseSecurity = new (require("../electron/release-security.cjs").ReleaseSecurityGate)({
      net: require("electron").net, appVersion: require("../package.json").version, isPackaged: false, testMode: true,
      resourcesPath: process.resourcesPath, executablePath: process.execPath, userDataPath: app.getPath("userData")
    });
    for (const name of ["statusTimer", "accountTimer", "heartbeatTimer", "chatTimer", "roomTimer", "gameFrameTimer", "gameWakeTimer", "introWakeTimer"]) clearInterval(backend[name]);
    backend.emit = () => {};
    backend.appendSessionLog = () => {};
    backend.origin = selection.origin;
    backend.domainSelected = true;
    await backend.networkReady;
    await backend.login({ account: credentials.account, password: credentials.password, remember: false });
    credentials.password = "";
    console.log(JSON.stringify({ stage: "authenticated", origin: backend.origin }));
    const models = require("../electron/auto-model-router.cjs").normalizeCatalog(await backend.platformGoApi("/workspaces/model-list"));
    report.models = require("../electron/auto-model-router.cjs").rankEditorModels(models).slice(0, 15).map(m => ({ model: m.model, label: m.label, tier: require("../electron/auto-model-router.cjs").editorModelTier(m) }));
    console.log(JSON.stringify({ stage: "models", models: report.models }));
    if (process.argv.includes("--assets")) {
      const previous = JSON.parse(fs.readFileSync(path.join(output, "discovery.json"), "utf8"));
      for (const asset of [...new Set(previous.discovered.filter(x => /files\/upload|chat_message_history/.test(x.snippet)).map(x => x.asset))]) {
        const text = await (await backend.platformSession.fetch(`${backend.origin}${asset}`)).text();
        fs.mkdirSync(path.join(output, "assets"), { recursive: true });
        fs.writeFileSync(path.join(output, "assets", path.basename(asset)), text);
      }
      console.log("ASSETS SAVED"); return;
    }
    if (process.argv.includes("--attachments")) {
      const workId = await require("../electron/editor-harness-backend.cjs").ensureHarnessWork(backend);
      backend.onlineWorldEditorSessionKey = "attachment-probe";
      const marker = `FYOW-${require("node:crypto").randomUUID()}`;
      const attachment = await require("../electron/harness-attachments.cjs").uploadHarnessText(backend, { name: "harness-attachment-probe.txt", content: `This is a disposable model attachment test.\nUnique marker: ${marker}\n` });
      const response = await backend.withAutoModel(workId, "附件读取验证", async ({ model, signal }) => {
        const result = await backend.requestEditorModelForWork(workId, 'Read the attached text file. Return only JSON {"marker":"the exact unique marker from the file"}. Do not guess if the attachment is missing.', { files: [attachment], signal });
        return { answer: result.answer, model: model.model };
      }, { scope: "online-world-editor", maxAttempts: 2 });
      const passed = response.answer.includes(marker);
      const evidence = { uploadRoute: "/console/api/files/upload", uploaded: true, model: response.model, consumedByModel: passed, answer: response.answer.slice(0, 1000) };
      fs.writeFileSync(path.join(output, "attachment-probe.json"), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ stage: "attachment-result", ...evidence }));
      resultCode = passed ? 0 : 1; return;
    }
    const repairKey = process.argv.find(a => a.startsWith("--repair-candidate="))?.slice("--repair-candidate=".length);
    if (process.argv.includes("--live") || repairKey) {
      let last = "";
      backend.emit = () => {
        const job = backend.onlineWorldEditorJob;
        const event = job?.events?.at(-1);
        const status = JSON.stringify({ stage: "harness", status: job?.status, tool: event?.tool, summary: event?.summary, error: event?.error, model: event?.model, budget: job?.budget, primaryModel: job?.coordinator?.primaryModel });
        if (status !== last) { console.log(status); last = status; }
      };
      let draft, repairGoal;
      if (repairKey) {
        const source = path.join(process.env.APPDATA, "风月联机工具/online-world/editor-projects/default.json");
        const project = JSON.parse(fs.readFileSync(source, "utf8")).projects[repairKey];
        if (!project?.harnessCandidate?.goal) throw new Error("没有可续接的失败候选");
        repairGoal = project.harnessCandidate.goal;
        backend.onlineWorldEditorProjects.projects[repairKey] = JSON.parse(JSON.stringify(project));
        draft = { libraryId: repairKey };
      } else draft = await backend.createOnlineWorldCardEditor();
      const result = await backend.runOnlineWorldEditorAgents({ libraryId: draft.libraryId,
        budgetPoints: 80000, goal: repairGoal || "把当前独立探索样例改成《星港维修》：保持三个操作进度、体力、胜利失败、重开和存档玩法，但将遗迹房间改为气闸、控制室、通讯舱、指挥台，把探索行动改为维修，胜利表现为通讯恢复。同步修改所有玩家可见文案和对应的 DOM 测试断言。完成真实浏览器测试并请求另一模型审查。保持程序精简，不添加额外网络或图片。" });
      if (repairKey) {
        fs.writeFileSync(path.join(output, "repaired-candidate.json"), JSON.stringify(result.project, null, 2));
        console.log(JSON.stringify({ stage: "candidate-repaired-in-isolated-profile", models: result.project.harness.models, budget: result.project.harness.budget, passed: result.project.harness.evidence.passed }));
        return;
      }
      fs.writeFileSync(path.join(output, "live-project.json"), JSON.stringify(result.project, null, 2));
      console.log(JSON.stringify({ stage: "live-complete", models: result.project.harness.models, evidence: result.project.harness.evidence.passed }));
      const saved = await backend.saveOnlineWorldCardEditor(draft.libraryId, result.project, { publish: true });
      const card = backend.onlineWorldCard(saved.card.libraryId || saved.card.cardId);
      fs.writeFileSync(path.join(output, "live-card.json"), JSON.stringify(card, null, 2));
      const opened = await backend.openOnlineWorldCard({ libraryId: saved.card.libraryId });
      if (opened.runtime !== "standalone/1" || !opened.initialized || opened.status !== "ready") throw new Error("云端回读后的卡片没有进入独立玩法");
      backend.onlineWorldService.saveStandaloneState({ workId: card.companion.workId, gameId: card.gameId, data: { version: 1, step: 1, hp: 3 } });
      await backend.onlineWorldService.pause();
      const reopened = await backend.openOnlineWorldCard({ libraryId: saved.card.libraryId });
      if (reopened.gameSave?.step !== 1) throw new Error("保存后的卡片未恢复进度");
      fs.writeFileSync(path.join(output, "cloud-roundtrip.json"), JSON.stringify({ workId: card.companion.workId, cardId: card.cardId, runtime: reopened.runtime, restored: reopened.gameSave, packageSha256: card.packageSha256 }, null, 2));
      console.log(JSON.stringify({ stage: "cloud-save-open-restore-passed", title: card.title, runtime: reopened.runtime }));
      return;
    }
    await backend.anchor.loadURL(`${backend.origin}/zh/explore/installed/0f357d8b-6170-4a22-afa7-72fef3490890`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const urls = await backend.anchor.webContents.executeJavaScript("[...new Set([...document.scripts].map(s=>s.src).concat(performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/\\.js(?:\\?|$)/.test(n))))].filter(Boolean)");
    for (const url of urls.slice(0, 100)) {
      if (new URL(url).origin !== backend.origin) continue;
      const response = await backend.platformSession.fetch(url);
      const text = await response.text();
      if (text.length > 5000000) continue;
      if (/files\/upload|chat_message_history/.test(text)) {
        fs.mkdirSync(path.join(output, "assets"), { recursive: true });
        fs.writeFileSync(path.join(output, "assets", path.basename(new URL(url).pathname)), text);
      }
      for (const match of text.matchAll(/(?:files?\/upload|upload-file|upload_file_id|transfer_method|chat_message_history|biz=)[^\n]{0,120}/g)) {
        const snippet = text.slice(Math.max(0, match.index - 180), match.index + 400);
        report.discovered.push({ asset: new URL(url).pathname, snippet });
      }
    }
    console.log(JSON.stringify({ stage: "upload-evidence", matches: report.discovered.slice(0, 20) }));
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "discovery.json"), JSON.stringify(report, null, 2));
    console.log("PLATFORM DISCOVERY COMPLETE");
    return;
  } catch (error) {
    console.error(error.message); resultCode = 1;
    if (process.argv.includes("--attachments")) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "attachment-probe.json"), JSON.stringify({ uploadRoute: "/console/api/files/upload", uploaded: false, consumedByModel: false, error: error.message }, null, 2));
    }
  } finally {
    clearTimeout(timeout); backend?.destroy(); if (window && !window.isDestroyed()) window.destroy(); app.exit(resultCode);
  }
});
