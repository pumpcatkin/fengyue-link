"use strict";
const { BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { injectSandboxCsp } = require("./online-world-runtime.cjs");
const { validateModelFixtureUsage, validateTests } = require("./game-harness.cjs");
const { isStandalone, validateSave } = require("./standalone-game.cjs");
const { assertActive } = require("./auto-model-router.cjs");
const { normalizeModelTasks, resolveModelTask, validateModelTaskInput, validateModelTaskOutput } = require("./model-task-contract.cjs");
const bridge = require("./desktop/game-bridge.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function visibleTextContainsNumber(text, value) {
  const literal = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9.])${literal}(?=$|[^0-9.])`).test(String(text || ""));
}

function assertModelUsageEvidence({ scenarioName, steps, modelCalls, modelFixtures }) {
  return modelCalls.map((call, callIndex) => {
    const usage = modelFixtures?.[call.taskId]?.usage;
    if (!usage) throw new Error(`场景“${scenarioName || "未命名"}”的模型任务 ${call.taskId} 缺少积分夹具`);
    const stepIndex = steps.findIndex(step => Number(step.modelCallCount) >= callIndex + 1
      && visibleTextContainsNumber(step.text, usage.total)
      && visibleTextContainsNumber(step.text, usage.remainingPoints));
    if (stepIndex < 0) {
      throw new Error(`场景“${scenarioName || "未命名"}”的模型任务 ${call.taskId} 第 ${callIndex + 1} 次调用缺少可见积分证据：调用后的场景步骤文本必须同时包含总消耗 ${usage.total} 和剩余积分 ${usage.remainingPoints}`);
    }
    return { taskId: call.taskId, call: callIndex + 1, step: stepIndex + 1, total: usage.total, remainingPoints: usage.remainingPoints };
  });
}

async function testGameInBrowser(html, tests, signal, { timeoutMs = 45000, modelTasks = null } = {}) {
  validateTests(tests);
  if (!isStandalone(html)) return { passed: false, errors: ["自动玩法验收目前支持 standalone/1；疆土引擎修改需使用专用回归，不能假称已验收"] };
  const taskManifest = normalizeModelTasks(modelTasks);
  const modelFixtures = {};
  const declaredTaskIds = new Set(taskManifest.tasks.map(task => task.taskId));
  for (const task of taskManifest.tasks) {
    const fixture = tests.modelFixtures?.[task.taskId];
    if (!fixture) return { passed: false, errors: [`模型任务 ${task.taskId} 缺少 tests.json.modelFixtures 测试结果`] };
    modelFixtures[task.taskId] = {
      output: validateModelTaskOutput(task, fixture.output),
      usage: validateModelFixtureUsage(fixture.usage, task.taskId)
    };
  }
  for (const taskId of Object.keys(tests.modelFixtures || {})) {
    if (!declaredTaskIds.has(taskId)) return { passed: false, errors: [`模型测试夹具引用了未登记任务：${taskId}`] };
  }
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
  const errors = [], results = [], consoleErrors = [], calledTaskIds = new Set();
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
      const frame=document.querySelector('iframe');let saved=null;let ready=0;let writes=0;let closed=false;let returns=0;const errors=[];const modelCalls=[];const modelResults=new Map();
      const valid=${validateSave.toString().replace('Buffer.byteLength(text)', 'new TextEncoder().encode(text).byteLength')};
      const source='fengyue-host',protocol='fyow-host/1';let lastWriteAt=0;
      const modelTasks=${JSON.stringify(taskManifest.tasks).replace(/</g, "\\u003c")};
      const modelFixtures=${JSON.stringify(modelFixtures).replace(/</g, "\\u003c")};
      const validRequestId=${String(bridge.validRequestId).replace(/^validRequestId/, 'function')};
      const program=${JSON.stringify(program).replace(/</g, "\\u003c")};
      window.fixture={get saved(){return saved},get ready(){return ready},get writes(){return writes},get closed(){return closed},get returns(){return returns},errors,modelCalls,reopen(){if(!closed)throw Error('游戏尚未返回大厅');closed=false;frame.srcdoc=program;}};
      addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;if(e.data?.harnessError){errors.push(e.data.harnessError);return;}
        const d=e.data;
        if(d?.source==='fyow-game-card'&&d.protocol==='fyow-host/2'){
          const reply=message=>frame.contentWindow.postMessage({source,protocol:'fyow-host/2',requestId:d.requestId,...message},'*');
          const task=modelTasks.find(item=>item.taskId===d.params?.taskId),fixture=task&&modelFixtures[task.taskId];
          if(d.kind!=='request'||d.method!=='model.run'||!validRequestId(d.requestId)||!validRequestId(d.params?.idempotencyKey)||!task||!fixture){errors.push('通用模型请求无效或引用了未登记任务');reply({kind:'result',ok:false,error:{message:'模型任务未登记',errorCode:'MODEL_TASK_UNKNOWN'}});return;}
          const key=task.taskId+':'+d.params.idempotencyKey;
          if(!modelResults.has(key)){const result={operationId:d.params.idempotencyKey,taskId:task.taskId,taskVersion:task.version,output:fixture.output,usage:fixture.usage};modelResults.set(key,result);modelCalls.push({taskId:task.taskId,input:d.params.input,idempotencyKey:d.params.idempotencyKey});}
          reply({kind:'result',ok:true,result:modelResults.get(key)});return;
        }
        if(!['fyow-grid-conquest','fyow-game-card'].includes(d?.source)||d.protocol!==protocol)return;
        if(closed)return;
        if(d.type==='library'){closed=true;returns++;frame.srcdoc='';return;}
        if(d.type==='ready'){ready++;frame.contentWindow.postMessage({source,protocol,type:'state',state:{runtime:'standalone/1',initialized:true,status:'ready',gameSave:saved,card:{title:'测试游戏'}}},'*');}
        if(d.type==='game-save'){if(!validRequestId(d.requestId)){errors.push('存档 requestId 不符合真实宿主协议');return;}try{if(Date.now()-lastWriteAt<${bridge.minimumSaveInterval})throw Error('存档过于频繁，请合并变更后重试');saved=valid(d.data);lastWriteAt=Date.now();writes++;frame.contentWindow.postMessage({source,protocol,type:'result',requestId:d.requestId,result:{saved:true}},'*');}catch(error){errors.push(error.message);frame.contentWindow.postMessage({source,protocol,type:'error',requestId:d.requestId,message:error.message},'*');}}
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
        return { action: "reopen", changed: true,
          text: (await getFrame().executeJavaScript("document.body.innerText")).slice(0, 4000),
          modelCallCount: await evaluateHost("fixture.modelCalls.length") };
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
      if (await evaluateHost("fixture.closed")) return { action: step.action, selector: step.selector, changed: true,
        text: "已返回游戏大厅", modelCallCount: await evaluateHost("fixture.modelCalls.length") };
      const text = await getFrame().executeJavaScript("document.body.innerText");
      return { action: step.action, selector: step.selector, changed: outcome.before !== text,
        text: text.slice(0, 4000), modelCallCount: await evaluateHost("fixture.modelCalls.length") };
    };
    fs.writeFileSync(fixtureFile, fixture);
    for (const scenario of tests.scenarios) {
      phase = `场景：${scenario.name || "未命名"}`;
      currentStep = null;
      await win.loadFile(fixtureFile);
      await waitReady(1);
      const steps = [], evidenceSteps = [];
      const capture = async step => {
        const result = await action(step);
        evidenceSteps.push(result);
        return result;
      };
      for (const step of scenario.steps) steps.push(await capture(step));
      await capture({ ...scenario.terminal, action: "assert" });
      steps.push(await capture(scenario.restart));
      await capture({ ...scenario.reset, action: "assert" });
      if (steps.filter(s => s.changed && s.action !== "assert").length < 2) throw new Error("玩家操作未产生至少两次可见状态变化");
      let storage;
      for (let i = 0; i < 30; i++) {
        storage = await evaluateHost("({saved:fixture.saved,writes:fixture.writes,errors:fixture.errors})");
        if (storage.writes > 0) break;
        await sleep(100);
      }
      if (!storage.writes || !storage.saved) throw new Error(`玩法没有通过宿主桥保存有效存档：${storage.errors.join("；")}`);
      // Save an intermediate state too: reset-only assertions cannot prove resume works.
      await capture(scenario.steps.find(s => s.action !== "assert"));
      await sleep(400);
      const beforeReload = await evaluateHost("JSON.stringify(fixture.saved)");
      let readyCount = await evaluateHost("fixture.ready");
      await evaluateHost("document.querySelector('iframe').srcdoc=document.querySelector('iframe').srcdoc");
      await waitReady(readyCount + 1);
      if (await evaluateHost("JSON.stringify(fixture.saved)") !== beforeReload) throw new Error("恢复存档时覆盖了宿主状态");
      await capture({ ...scenario.resumed, action: "assert" });
      // Return to the reset state before checking the declared persisted assertion.
      await capture(scenario.restart);
      await sleep(400);
      readyCount = await evaluateHost("fixture.ready");
      await evaluateHost("document.querySelector('iframe').srcdoc=document.querySelector('iframe').srcdoc");
      await waitReady(readyCount + 1);
      await capture({ ...scenario.persisted, action: "assert" });
      const layouts = [];
      for (const width of [1280, 420]) {
        win.setContentSize(width, 820); await sleep(100);
        layouts.push(await getFrame().executeJavaScript("({width:innerWidth,scroll:document.documentElement.scrollWidth})"));
      }
      if (layouts.some(l => l.scroll > l.width + 1)) throw new Error("手机或桌面宽度出现横向溢出");
      const runtimeErrors = await evaluateHost("fixture.errors");
      if (runtimeErrors.length) throw new Error(runtimeErrors.join("\n").slice(0, 4000));
      const modelCalls = await evaluateHost("fixture.modelCalls");
      for (const call of modelCalls) {
        const task = resolveModelTask(taskManifest, call.taskId);
        validateModelTaskInput(task, call.input);
        calledTaskIds.add(call.taskId);
      }
      const modelUsageEvidence = assertModelUsageEvidence({ scenarioName: scenario.name, steps: evidenceSteps, modelCalls, modelFixtures });
      results.push({ name: scenario.name, steps, layouts, storageWrites: storage.writes, libraryReturns: await evaluateHost("fixture.returns"), modelCalls, modelUsageEvidence, restored: true });
    }
    const missingTasks = taskManifest.tasks.map(task => task.taskId).filter(taskId => !calledTaskIds.has(taskId));
    if (missingTasks.length) throw new Error(`以下模型任务没有被浏览器场景实际调用：${missingTasks.join("、")}`);
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
module.exports = { assertModelUsageEvidence, testGameInBrowser, visibleTextContainsNumber };
