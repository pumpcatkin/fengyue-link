"use strict";
const { BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { injectSandboxCsp } = require("./online-world-runtime.cjs");
const { validateTests } = require("./game-harness.cjs");
const { isStandalone, validateSave } = require("./standalone-game.cjs");
const { assertActive } = require("./auto-model-router.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testGameInBrowser(html, tests, signal, { timeoutMs = 45000 } = {}) {
  validateTests(tests);
  if (!isStandalone(html)) return { passed: false, errors: ["自动玩法验收目前支持 standalone/1；疆土引擎修改需使用专用回归，不能假称已验收"] };
  const partition = `harness-${crypto.randomUUID()}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fyow-harness-"));
  const fixtureFile = path.join(directory, "host.html");
  const isolated = session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "file://*/*"] }, (details, callback) => callback({
    cancel: !(details.resourceType === "mainFrame" && details.url.startsWith("file:")
      && path.resolve(require("node:url").fileURLToPath(details.url)).toLowerCase() === path.resolve(fixtureFile).toLowerCase())
  }));
  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  const errors = [], results = [], consoleErrors = [];
  let phase = "初始化浏览器", currentStep = null;
  const describe = error => typeof error === "string" ? error : error?.message || String(error || "未知浏览器错误");
  win.webContents.on("console-message", event => {
    if (event.message && event.level === "error") consoleErrors.push(String(event.message).slice(0, 1600));
  });
  const abort = () => { if (!win.isDestroyed()) win.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { abort(); reject(new Error("浏览器验收超时，可能存在死循环或未响应操作")); }, timeoutMs); });
  const run = async () => {
    assertActive(signal);
    const monitor = `<script>addEventListener('error',e=>parent.postMessage({harnessError:String(e.message)},'*'));addEventListener('unhandledrejection',e=>parent.postMessage({harnessError:String(e.reason)},'*'));</script>`;
    const program = injectSandboxCsp(html.replace(/<head[^>]*>/i, match => match + monitor));
    const fixture = `<!doctype html><html><head><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts"></iframe><script>
      const frame=document.querySelector('iframe');let saved=null;let ready=0;let writes=0;let closed=false;let returns=0;const errors=[];
      const valid=${validateSave.toString().replace('Buffer.byteLength(text)', 'new TextEncoder().encode(text).byteLength')};
      const source='fengyue-host',protocol='fyow-host/1';
      const program=${JSON.stringify(program).replace(/</g, "\\u003c")};
      window.fixture={get saved(){return saved},get ready(){return ready},get writes(){return writes},get closed(){return closed},get returns(){return returns},errors,reopen(){if(!closed)throw Error('游戏尚未返回大厅');closed=false;frame.srcdoc=program;}};
      addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;if(e.data?.harnessError){errors.push(e.data.harnessError);return;}
        const d=e.data;if(d?.source!=='fyow-grid-conquest'||d.protocol!==protocol)return;
        if(closed)return;
        if(d.type==='library'){closed=true;returns++;frame.srcdoc='';return;}
        if(d.type==='ready'){ready++;frame.contentWindow.postMessage({source,protocol,type:'state',state:{runtime:'standalone/1',initialized:true,status:'ready',gameSave:saved,card:{title:'测试游戏'}}},'*');}
        if(d.type==='game-save'&&/^[0-9a-f-]{36}$/i.test(d.requestId||'')){try{saved=valid(d.data);writes++;frame.contentWindow.postMessage({source,protocol,type:'result',requestId:d.requestId,result:{saved:true}},'*');}catch(error){errors.push(error.message);frame.contentWindow.postMessage({source,protocol,type:'error',requestId:d.requestId,message:error.message},'*');}}
      });frame.srcdoc=program;</script></body></html>`;
    const evaluateHost = code => win.webContents.executeJavaScript(code);
    const getFrame = () => win.webContents.mainFrame.frames.find(frame => frame.url === "about:srcdoc");
    const waitReady = async count => {
      for (let i = 0; i < 80; i++) {
        assertActive(signal);
        if (await evaluateHost(`fixture.ready >= ${count}`)) return;
        await sleep(50);
      }
      throw new Error("程序未发送 ready，或脚本执行失败");
    };
    const action = async step => {
      assertActive(signal);
      currentStep = step;
      const closed = await evaluateHost("fixture.closed");
      if (step.action === "reopen") {
        if (!closed) throw new Error("reopen 只能在游戏已返回大厅后执行");
        const count = await evaluateHost("fixture.ready");
        await evaluateHost("fixture.reopen()");
        await waitReady(count + 1);
        return { action: "reopen", changed: true, text: (await getFrame().executeJavaScript("document.body.innerText")).slice(0, 1500) };
      }
      if (closed) throw new Error("游戏已返回大厅，请先加入 {action:'reopen'} 再断言恢复后的游戏状态");
      const frame = getFrame();
      if (!frame) throw new Error("游戏 iframe 尚未就绪或已经退出");
      const outcome = await frame.executeJavaScript(`(() => { try {
        const step=${JSON.stringify(step)};const el=document.querySelector(step.selector);
        if(!el)throw Error('找不到元素：'+step.selector);
        const rect=el.getBoundingClientRect();if(!rect.width||!rect.height||getComputedStyle(el).visibility==='hidden')throw Error('测试元素不可见：'+step.selector);
        const before=document.body.innerText;
        if(step.action==='click'){if(el.disabled)throw Error('按钮禁用：'+step.selector);el.click();}
        else if(step.action==='fill'){el.value=String(step.value||'');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
        else if(step.action==='key'){el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:String(step.value),bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:String(step.value),bubbles:true}));}
        else if(!String(el.innerText??el.value??'').includes(step.includes))throw Error('断言失败：'+step.selector+' 应包含 '+step.includes+'，实际 '+String(el.innerText??el.value??'').slice(0,160));
        return {before,text:document.body.innerText.slice(0,4000)};
      } catch(error) { return {error:String(error?.message||error)}; }
      })()`);
      if (outcome?.error) throw new Error(outcome.error);
      await sleep(120);
      if (await evaluateHost("fixture.closed")) return { action: step.action, selector: step.selector, changed: true, text: "已返回游戏大厅" };
      const text = await getFrame().executeJavaScript("document.body.innerText");
      return { action: step.action, selector: step.selector, changed: outcome.before !== text, text: text.slice(0, 1500) };
    };
    fs.writeFileSync(fixtureFile, fixture);
    for (const scenario of tests.scenarios) {
      phase = `场景：${scenario.name || "未命名"}`;
      currentStep = null;
      await win.loadFile(fixtureFile);
      await waitReady(1);
      const steps = [];
      for (const step of scenario.steps) steps.push(await action(step));
      await action({ ...scenario.terminal, action: "assert" });
      steps.push(await action(scenario.restart));
      await action({ ...scenario.reset, action: "assert" });
      if (steps.filter(s => s.changed && s.action !== "assert").length < 2) throw new Error("玩家操作未产生至少两次可见状态变化");
      let storage;
      for (let i = 0; i < 30; i++) {
        storage = await evaluateHost("({saved:fixture.saved,writes:fixture.writes,errors:fixture.errors})");
        if (storage.writes > 0) break;
        await sleep(100);
      }
      if (!storage.writes || !storage.saved) throw new Error(`玩法没有通过宿主桥保存有效存档：${storage.errors.join("；")}`);
      // Save an intermediate state too: reset-only assertions cannot prove resume works.
      await action(scenario.steps.find(s => s.action !== "assert"));
      await sleep(400);
      const beforeReload = await evaluateHost("JSON.stringify(fixture.saved)");
      let readyCount = await evaluateHost("fixture.ready");
      await evaluateHost("document.querySelector('iframe').srcdoc=document.querySelector('iframe').srcdoc");
      await waitReady(readyCount + 1);
      if (await evaluateHost("JSON.stringify(fixture.saved)") !== beforeReload) throw new Error("恢复存档时覆盖了宿主状态");
      await action({ ...scenario.resumed, action: "assert" });
      // Return to the reset state before checking the declared persisted assertion.
      await action(scenario.restart);
      await sleep(400);
      readyCount = await evaluateHost("fixture.ready");
      await evaluateHost("document.querySelector('iframe').srcdoc=document.querySelector('iframe').srcdoc");
      await waitReady(readyCount + 1);
      await action({ ...scenario.persisted, action: "assert" });
      const layouts = [];
      for (const width of [1280, 420]) {
        win.setContentSize(width, 820); await sleep(100);
        layouts.push(await getFrame().executeJavaScript("({width:innerWidth,scroll:document.documentElement.scrollWidth})"));
      }
      if (layouts.some(l => l.scroll > l.width + 1)) throw new Error("手机或桌面宽度出现横向溢出");
      const runtimeErrors = await evaluateHost("fixture.errors");
      if (runtimeErrors.length) throw new Error(runtimeErrors.join("\n").slice(0, 4000));
      results.push({ name: scenario.name, steps, layouts, storageWrites: storage.writes, libraryReturns: await evaluateHost("fixture.returns"), restored: true });
    }
    return { passed: true, scenarios: results, errors: [], checkedAt: Date.now() };
  };
  try { return await Promise.race([run(), deadline]); }
  catch (error) {
    assertActive(signal);
    errors.push(describe(error));
    if (!win.isDestroyed()) {
      try { errors.push(...await win.webContents.executeJavaScript("window.fixture?.errors || []")); } catch {}
    }
    errors.push(...consoleErrors.slice(-6));
    return { passed: false, scenarios: results, errors: [...new Set(errors.filter(Boolean))], phase, step: currentStep, checkedAt: Date.now() };
  }
  finally {
    clearTimeout(timeout); signal?.removeEventListener("abort", abort); abort(); await isolated.clearStorageData();
    if (fs.existsSync(fixtureFile)) fs.unlinkSync(fixtureFile);
    fs.rmdirSync(directory);
  }
}
module.exports = { testGameInBrowser };
