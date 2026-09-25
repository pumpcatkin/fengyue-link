"use strict";

const { app, BrowserWindow, safeStorage, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readJsonWithBackupSync } = require("../electron/runtime-utils.cjs");
const { createBundledGridCard, createExportedGameCard, configurationDigest, normalizeConfiguration, rebindGameCard, validateGameCard } = require("../electron/online-world-card.cjs");
const { FYOW_SCHEMAS, canonicalJson, encodeCommentRecord, decodeCommentChunk, extractCommentItems, assembleCommentRecords, signRecord, verifySignedRecord } = require("../electron/online-world-protocol.cjs");
const { parseProgram } = require("../electron/online-world-runtime.cjs");
const { consumeModelEventStream, createModelRequestPayload } = require("../electron/model-stream.cjs");
const { createWorld, createFallbackGeneral, ensureGeneralProfile, publicGeneralState, buildPlayerProfileContextRequest, buildGeneralGenerationRequest, buildGeneralDialogueRequest, buildGeneralMemoryUpdateRequest } = require("../electron/grid-world-game.cjs");
const { OnlineWorldService, parseJsonAnswer, playerContextQualityIssue, generalGenerationQualityIssue, dialogueQualityIssue, generalMemoryQualityIssue, comparePlatformOrder, recordPlatformOrder, exportedConfig, modelConfigSavePayload, coreConfigMatches } = require("../electron/online-world-service.cjs");

const ORIGIN = "https://staging.aiero.cc";
const PROFILE_ID = String(process.env.FYOW_PROFILE_ID || "default").replace(/[^0-9a-z._-]/gi, "-").slice(0, 80) || "default";
const TIMEOUT_MS = 120_000;
app.setName("风月联机工具");
app.setPath("userData", path.join(app.getPath("appData"), "风月联机工具"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function credentialFile() {
  return path.join(app.getPath("appData"), "风月联机工具", "credentials", `${PROFILE_ID}.json`);
}

function loadCredentials() {
  if (process.env.FYOW_ACCOUNT && process.env.FYOW_PASSWORD) {
    return { account: String(process.env.FYOW_ACCOUNT), password: String(process.env.FYOW_PASSWORD) };
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 加密存储当前不可用");
  const file = credentialFile();
  const payload = readJsonWithBackupSync(fs, file, value => typeof value?.encrypted === "string" && value.encrypted.length > 0).value;
  if (!payload?.encrypted) throw new Error(`账号实例 ${PROFILE_ID} 没有已保存登录信息`);
  const credentials = JSON.parse(safeStorage.decryptString(Buffer.from(payload.encrypted, "base64")));
  if (!credentials?.account || !credentials?.password) throw new Error(`账号实例 ${PROFILE_ID} 的登录信息不完整`);
  return credentials;
}

async function load(window, pathname) {
  await window.loadURL(`${ORIGIN}${pathname}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (window.webContents.isLoading() && Date.now() < deadline) await sleep(100);
  if (window.webContents.isLoading()) throw new Error(`页面加载超时：${pathname}`);
}

async function login(window, credentials) {
  await load(window, "/zh/signin");
  const result = await window.webContents.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    let accountInput;
    let passwordInput;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      accountInput = [...document.querySelectorAll('#email,input[autocomplete="username"],input[placeholder*="邮箱"],input[placeholder*="用户名"],input')].find(element => visible(element) && element.type !== 'password');
      passwordInput = [...document.querySelectorAll('#password,input[autocomplete="current-password"],input[type="password"]')].find(visible);
      if (accountInput && passwordInput) break;
      await sleep(100);
    }
    if (!accountInput || !passwordInput) return { ok:false, reason:'missing-form' };
    const setValue = (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
      element.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value }));
      element.dispatchEvent(new Event('change', { bubbles:true }));
    };
    setValue(accountInput, ${JSON.stringify(credentials.account)});
    setValue(passwordInput, ${JSON.stringify(credentials.password)});
    const form = passwordInput.closest('form') || accountInput.closest('form');
    const submit = [...(form?.querySelectorAll('button[type="submit"],input[type="submit"]') || [])].find(visible)
      || [...document.querySelectorAll('button')].find(button => visible(button) && /^(登录|登錄|Sign in)$/i.test((button.textContent || '').trim()));
    if (!submit) return { ok:false, reason:'missing-submit' };
    submit.click();
    return { ok:true };
  })()`, true);
  if (!result?.ok) throw new Error(`登录表单提交失败：${result?.reason || "unknown"}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const authenticated = await window.webContents.executeJavaScript(`(() => {
      const path = location.pathname;
      const hasToken = Boolean(localStorage.getItem('console_token'));
      const loginButton = [...document.querySelectorAll('button,a')].some(element => /^(登录|登錄|Sign in)$/i.test((element.textContent || '').trim()));
      return hasToken || (!/\\/(signin|login)/i.test(path) && !loginButton);
    })()`, true).catch(() => false);
    if (authenticated) return;
  }
  const diagnostic = await window.webContents.executeJavaScript(`(() => ({
    path:location.pathname,
    title:document.title,
    alerts:[...document.querySelectorAll('[role="alert"],[data-sonner-toast]')].map(element => (element.textContent || '').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,5),
    buttons:[...document.querySelectorAll('button')].filter(element => element.getClientRects().length).map(element => (element.textContent || '').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,20)
  }))()`, true).catch(() => null);
  throw new Error(`登录验证超时：${JSON.stringify(diagnostic)}`);
}

async function api(window, pathname, { method = "GET", body } = {}) {
  return window.webContents.executeJavaScript(`(async () => {
    const token = localStorage.getItem('console_token') || '';
    const headers = {'Content-Type':'application/json','X-Language':'zh-Hans'};
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(${JSON.stringify(pathname)}, {
      method:${JSON.stringify(method)}, credentials:'include', cache:'no-store',
      headers,
      ${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw:text.slice(0, 500) }; }
    return { ok:response.ok, status:response.status, payload };
  })()`, true);
}

function unwrap(response) {
  const payload = response?.payload;
  return payload?.code === 100000 ? payload.data : (payload?.data ?? payload);
}

function findConfig(root) {
  const queue = [root];
  const seen = new Set();
  while (queue.length && seen.size < 1000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value)
      && ["world_book", "wbook", "lore_bk", "world_bk", "wb"].some(key => Array.isArray(value[key]))
      && ["prpt", "ppt", "pre_pt", "prompt_pre", "pre_prompt"].some(key => Object.hasOwn(value, key))) return value;
    queue.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return root;
}

function toSavePayload(exported, desired) {
  const payload = JSON.parse(JSON.stringify(exported || {}));
  const taskKeys = new Set(desired.world_book.map(entry => String(entry.key)));
  const currentBooks = payload.world_book || payload.wbook || payload.lore_bk || payload.world_bk || payload.wb || [];
  const preserved = currentBooks.filter(entry => !taskKeys.has(String(entry?.key || "")));
  payload.app = {
    ...(payload.app && typeof payload.app === "object" ? payload.app : {}),
    id: desired.app.id,
    name: desired.app.name,
    description: desired.app.description,
    summary: desired.app.summary,
    language: String(payload.lang ?? payload.locale ?? payload.lc ?? payload.lng ?? payload.language ?? desired.app.language ?? "zh-Hans")
  };
  payload.pre_text = desired.pre_text;
  payload.pre_prompt = desired.pre_prompt;
  payload.post_text = desired.post_text;
  payload.world_book = [...preserved, ...desired.world_book];
  return payload;
}

function shapeOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, item]) => ({
    key,
    type: Array.isArray(item) ? "array" : typeof item,
    length: typeof item === "string" || Array.isArray(item) ? item.length : undefined
  }));
}

function loadOnlineWorldIdentity(accountId) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 加密存储当前不可用");
  const safeAccountId = String(accountId || "").replace(/[^0-9a-z._-]/gi, "-").slice(0, 80);
  const file = path.join(app.getPath("userData"), "online-world", "identities", `${PROFILE_ID}-${safeAccountId}.json`);
  const payload = readJsonWithBackupSync(fs, file, value => value?.version === 1 && typeof value?.encrypted === "string").value;
  const identity = JSON.parse(safeStorage.decryptString(Buffer.from(payload.encrypted, "base64")));
  if (!identity?.signingPrivateKey || !identity?.signingPublicKey) throw new Error("本机在线世界身份记录不完整");
  return identity;
}

function identityFieldPaths(root) {
  const result = [];
  const queue = [{ value: root, path: "$", depth: 0 }];
  const seen = new Set();
  while (queue.length && seen.size < 2000) {
    const { value, path: valuePath, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${valuePath}.${key}`;
      if (child && typeof child === "object") queue.push({ value: child, path: childPath, depth: depth + 1 });
      else if (/author|creator|owner|created_by|account|user|name|^id$/i.test(key)) result.push({ path: childPath, value: String(child ?? "").slice(0, 160) });
    }
  }
  return result;
}

function roleKeys(value, desired) {
  const roles = {};
  for (const [key, item] of Object.entries(value && typeof value === "object" ? value : {})) {
    if (item === desired.app.name) roles.name = key;
    if (item === desired.app.summary) roles.summary = key;
    if (item === desired.app.description) roles.description = key;
    if (item === desired.pre_text) roles.preText = key;
    if (item === desired.pre_prompt) roles.prePrompt = key;
    if (item === desired.post_text) roles.postText = key;
    if (Array.isArray(item) && item.length === desired.world_book.length
      && desired.world_book.every(expected => item.some(entry => String(entry?.key || "") === expected.key))) roles.worldBook = key;
  }
  return roles;
}

async function captureUiSaveTemplate(window, platformSession, desired, workId) {
  let capturedBody = null;
  let resolveCapture;
  const captured = new Promise(resolve => { resolveCapture = resolve; });
  platformSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let pathname = "";
    try { pathname = new URL(details.url).pathname; } catch {}
    if (details.method === "POST" && pathname === `/console/api/apps/${workId}/model-config`) {
      capturedBody = (details.uploadData || [])
        .map(item => item.bytes ? Buffer.from(item.bytes).toString("utf8") : "")
        .join("");
      resolveCapture(capturedBody);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  const ui = await window.webContents.executeJavaScript(`(async () => {
    const desired = ${JSON.stringify({
      name: desired.app.name,
      summary: desired.app.summary,
      description: desired.app.description,
      preText: desired.pre_text,
      prePrompt: desired.pre_prompt,
      postText: desired.post_text
    })};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const candidates = () => [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(visible);
    const byPlaceholder = text => candidates().find(element => String(element.getAttribute('placeholder') || '').includes(text));
    const byLabel = text => {
      const label = [...document.querySelectorAll('label')].find(element => visible(element) && String(element.textContent || '').replace(/\\s+/g, ' ').includes(text));
      return label?.querySelector('input,textarea,[contenteditable="true"]') || null;
    };
    const setValue = (element, value) => {
      if (!element) throw new Error('缺少创作字段');
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
      } else {
        element.textContent = value;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value }));
      element.dispatchEvent(new Event('change', { bubbles:true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles:true }));
      const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps$'));
      const props = propsKey ? element[propsKey] : null;
      if (typeof props?.onChange === 'function') props.onChange({ target:element, currentTarget:element, type:'change', persist() {}, preventDefault() {}, stopPropagation() {} });
    };
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (byPlaceholder('给你的作品起个名字') && byPlaceholder('严格遵循回复示例') && byPlaceholder('-我的世界观内容是')) break;
      await sleep(100);
    }
    const fields = {
      name: byPlaceholder('给你的作品起个名字') || byLabel('作品名称'),
      summary: byPlaceholder('给你的作品写一句简介') || byPlaceholder('Shift+回车可换行') || byLabel('简介'),
      description: byPlaceholder('<div class="custom-ui">') || byLabel('详细介绍'),
      preText: byPlaceholder('严格遵循回复示例') || byLabel('前置词'),
      prePrompt: byPlaceholder('-我的世界观内容是') || byLabel('提示词'),
      postText: byPlaceholder('使用优化小说文风') || byLabel('后置词')
    };
    const missing = ['name', 'summary'].filter(key => !fields[key]);
    if (missing.length) return { ok:false, missing, placeholders:candidates().map(element => element.getAttribute('placeholder')).filter(Boolean) };
    for (const [key, element] of Object.entries(fields)) if (element) setValue(element, desired[key]);
    await sleep(500);
    const save = [...document.querySelectorAll('button,[role="button"]')].find(element => visible(element) && String(element.textContent || '').replace(/\\s+/g, ' ').trim() === '保存');
    if (!save) return { ok:false, missing:['save-button'] };
    HTMLElement.prototype.click.call(save);
    let confirmationClicked = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const dialogs = [...document.querySelectorAll('[role="dialog"],[data-slot="dialog-content"]')].filter(visible);
      const dialog = dialogs.find(element => /更新日志/.test(String(element.textContent || ''))) || dialogs.at(-1);
      const confirm = dialog && [...dialog.querySelectorAll('button')].find(button => /^(确认|确定|Confirm)$/i.test(String(button.textContent || '').trim()));
      if (confirm) { HTMLElement.prototype.click.call(confirm); confirmationClicked = true; break; }
      await sleep(100);
    }
    return {
      ok:true,
      confirmationClicked,
      saveDisabled:Boolean(save.disabled || save.getAttribute('aria-disabled') === 'true'),
      dialogs:[...document.querySelectorAll('[role="dialog"],[data-slot="dialog-content"]')].filter(visible).map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim()).slice(-3),
      alerts:[...document.querySelectorAll('[role="alert"],[data-sonner-toast],[class*="toast" i]')].filter(visible).map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(-6),
      invalid:[...document.querySelectorAll('[aria-invalid="true"],:invalid')].filter(visible).map(element => ({ tag:element.tagName, placeholder:element.getAttribute('placeholder'), value:String(element.value || '').slice(0,80) })).slice(0,20)
    };
  })()`, true);
  if (!ui?.ok) {
    platformSession.webRequest.onBeforeRequest(null);
    throw new Error(`创作页保存载荷模板组装失败：${JSON.stringify(ui)}`);
  }
  await Promise.race([captured, sleep(20_000)]);
  platformSession.webRequest.onBeforeRequest(null);
  if (!capturedBody) throw new Error(`创作页没有发出保存请求：${JSON.stringify(ui)}`);
  try { return JSON.parse(capturedBody); } catch { throw new Error("创作页保存载荷不是 JSON"); }
}

function readbackChecks(exported, desired) {
  const description = String(exported?.desc ?? exported?.descr ?? exported?.dsc ?? exported?.intro ?? exported?.description ?? exported?.app?.description ?? "");
  const books = exported?.world_book || exported?.wbook || exported?.lore_bk || exported?.world_bk || exported?.wb || [];
  const desiredBooks = desired.world_book.map(entry => books.find(item => String(item?.key || "") === entry.key));
  return {
    name: String(exported?.name ?? exported?.nm ?? exported?.ttl ?? exported?.title ?? exported?.app_name ?? exported?.app?.name ?? "") === desired.app.name,
    summary: String(exported?.summary ?? exported?.smry ?? exported?.abs_txt ?? exported?.sum_info ?? exported?.abstract ?? exported?.app?.summary ?? "") === desired.app.summary,
    description: description === desired.app.description,
    preText: String(exported?.pretxt ?? exported?.ptx ?? exported?.pre_tx ?? exported?.prefix_txt ?? exported?.pre_text ?? "") === desired.pre_text,
    prePrompt: String(exported?.prpt ?? exported?.ppt ?? exported?.pre_pt ?? exported?.prompt_pre ?? exported?.pre_prompt ?? "") === desired.pre_prompt,
    postText: String(exported?.posttxt ?? exported?.potx ?? exported?.post_tx ?? exported?.suffix_txt ?? exported?.post_text ?? "") === desired.post_text,
    worldBookCount: desiredBooks.filter(Boolean).length,
    worldBooksUserScoped: desiredBooks.every(entry => entry?.key_region === 2 && entry?.enable === true && Number(entry?.probability) === 100)
  };
}

async function requestStructuredModelProbe(window, workId, request, validate, signal) {
  const token = String(await window.webContents.executeJavaScript("localStorage.getItem('console_token') || ''", true) || "");
  const keyword = String(request.keyword || `[[FYOW:TASK:${request.task}:v1]]`);
  const query = `${keyword}\n${JSON.stringify({ schema: "fyow.model-request/1", input: request.input || {} })}`;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) throw new Error("模型探针已取消");
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await window.webContents.session.fetch(new URL("/go/api/apps/chat-messages", ORIGIN).href, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "X-Language": "zh-Hans" },
      body: JSON.stringify(createModelRequestPayload({ workId, query }))
    });
    if (!response.ok || /json/i.test(String(response.headers.get("content-type") || ""))) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure?.message || failure?.msg || `模型探针失败：HTTP ${response.status}`);
    }
    const result = await consumeModelEventStream(response.body);
    if (!String(result.conversationId || "").trim()) throw new Error("模型探针完成后没有新会话编号");
    let parsed;
    try {
      parsed = parseJsonAnswer(result.answer);
    } catch (error) {
      const preview = String(result.answer || "").replace(/\s+/g, " ").slice(0, 1200);
      throw new Error(`${request.task || "模型探针"}解析失败：${error?.message || error}；返回长度 ${String(result.answer || "").length}；片段 ${JSON.stringify(preview)}`);
    }
    const issue = validate(parsed);
    if (issue) throw new Error(`模型探针质量校验失败：${issue}`);
    return { parsed, conversationId: result.conversationId, finishEvent: result.finishEvent, answerCharacters: result.answer.length, usage: result.usage, points: result.points };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

async function runAutomaticModelProbe(window, workId) {
  const vm = require("node:vm");
  const router = require("../electron/auto-model-router.cjs");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf("class AccountBackend"), source.indexOf("let mainWindow;"))}; AccountBackend`, {
    ...router, crypto, AbortController, setInterval, clearInterval
  });
  const backend = Object.create(Backend.prototype);
  const events = [];
  Object.assign(backend, {
    loggedIn: true, authSessionRevision: 1, work: { id: workId },
    autoModelJobs: new Map(), autoModelQueues: new Map(), emit: () => {},
    appendSessionLog: (kind, detail) => { if (kind === "auto-model") { events.push(detail); process.stdout.write(`${JSON.stringify({ stage: detail.stage, attempt: detail.attempt, model: detail.model })}\n`); } },
    platformGoApi: async (endpoint, options) => {
      const response = await api(window, `/go/api${endpoint}`, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data: unwrap(response) };
    }
  });
  const previous = unwrap(await api(window, `/go/api/apps/config?app_id=${encodeURIComponent(workId)}`));
  if (!previous?.model) throw new Error("探针未读到原模型，停止测试");
  const world = createWorld({ seed: "auto-model-probe", seasonId: "probe", startedAt: Date.now(), authorityAccountId: "probe" });
  const player = { accountId: "probe", displayName: "测试主公", position: { x: 1, y: 1 } };
  const general = createFallbackGeneral({ id: "probe-general", name: "青禾", gender: "female", holderAccountId: "probe", holderName: "测试主公", setting: "善于守城，重视约定的成年将领。", year: 1 });
  world.players.probe = player;
  world.privatePlayers.probe = { orientation: "women" };
  world.generals[general.id] = general;
  const request = buildGeneralDialogueRequest(world, general, player, "你好，请简短介绍你擅长的守城策略。", Date.now());
  const before = await readPlatformPointBalance(window);
  const timeout = setTimeout(() => backend.cancelAutoModels(), 240000);
  try {
    const result = await backend.withAutoModel(workId, "自动选模连通性探针", async ({ attempt, signal }) => {
      // The first failure is injected locally BEFORE generation: no paid request.
      if (attempt === 1) throw new Error("本地注入切换测试，不发送模型请求");
      return requestStructuredModelProbe(window, workId, request, value => dialogueQualityIssue(value, { captive: false, allowedRecipientKeys: [] }), signal);
    });
    const after = await readPlatformPointBalance(window);
    return { ok: true, injectedFailure: true, attempts: events.filter(item => item.stage === "generating").length,
      finishEvent: result.finishEvent, conversationCreated: Boolean(result.conversationId), answerCharacters: result.answerCharacters,
      points: result.points?.total ?? before.points - after.points, model: events.filter(item => item.stage === "generating").at(-1)?.model };
  } finally {
    clearTimeout(timeout);
    const restored = await api(window, "/go/api/apps/config", { method: "POST", body: { app_id: workId, model: previous.model } });
    if (!restored.ok) throw new Error("探针已完成，原模型配置恢复失败");
    const verified = unwrap(await api(window, `/go/api/apps/config?app_id=${encodeURIComponent(workId)}`));
    if (verified?.model?.provider !== previous.model.provider || verified?.model?.name !== previous.model.name) throw new Error("原模型配置恢复回读不一致");
  }
}

async function readPlatformPointBalance(window) {
  const profileResponse = await api(window, "/go/api/account/profile");
  if (!profileResponse.ok) throw new Error(`读取积分账号失败：HTTP ${profileResponse.status}`);
  const profile = unwrap(profileResponse);
  const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
  if (!accountId) throw new Error("积分账号没有返回账号编号");
  const pointResponse = await api(window, `/go/api/account/point?target=${encodeURIComponent(accountId)}`);
  if (!pointResponse.ok) throw new Error(`读取平台积分失败：HTTP ${pointResponse.status}`);
  const point = unwrap(pointResponse);
  const value = point?.points ?? point?.point ?? point?.balance ?? null;
  return { accountId, points: value == null ? null : Number(String(value).replace(/,/g, "")), raw: point };
}

async function runModelProbe(window, workId) {
  const profileRequest = buildPlayerProfileContextRequest({
    displayName: "茂密",
    basicInfo: "猫亚人",
    appearance: "白色头发"
  }, crypto.randomUUID());
  const profile = await requestStructuredModelProbe(window, workId, profileRequest, playerContextQualityIssue);
  const world = createWorld({ seed: "live-model-probe", seasonId: "probe", startedAt: Date.now(), authorityAccountId: "probe-player" });
  world.privatePlayers["probe-player"] = { orientation: "women", characterTags: [] };
  const effect = {
    type: "general-generation-request",
    accountId: "probe-player",
    initial: true,
    initialWish: "希望遇到一名白发猫亚人良将，善于守城，愿意与主公建立长期羁绊",
    gender: "female",
    population: 3200,
    resourceGrade: "A",
    x: 12,
    y: 18
  };
  const generalRequest = buildGeneralGenerationRequest(world, effect, crypto.randomUUID());
  const general = await requestStructuredModelProbe(window, workId, generalRequest, value => generalGenerationQualityIssue(value, effect));
  world.players["probe-player"] = { accountId: "probe-player", displayName: "茂密", position: { x: 12, y: 18 }, carriedGeneralIds: ["probe-general"] };
  world.players["former-player"] = { accountId: "former-player", displayName: "旧主青岚" };
  world.privatePlayers["probe-player"].playerContext = profile.parsed;
  world.generals["probe-general"] = createFallbackGeneral({
    id: "probe-general",
    ...general.parsed,
    holderAccountId: "probe-player",
    holderName: "茂密",
    year: 1
  });
  world.generals["probe-general"].masterHistory.unshift({ accountId: "former-player", fromYear: 1, toYear: 1, reason: "旧主" });
  const ordinaryRequest = buildGeneralDialogueRequest(world, world.generals["probe-general"], world.players["probe-player"], "初来此地，你如何看待未来的疆土与我们的相处？", Date.now());
  const ordinary = await requestStructuredModelProbe(window, workId, ordinaryRequest, value => dialogueQualityIssue(value, { captive: false, allowedRecipientKeys: ordinaryRequest.routing.formerLords.map(item => item.recipientKey) }));
  const memoryRequest = buildGeneralMemoryUpdateRequest(world, world.generals["probe-general"], world.players["probe-player"], { userText: ordinaryRequest.input.topic, reply: ordinary.parsed.reply, idempotencyKey: crypto.randomUUID() }, Date.now());
  const memory = await requestStructuredModelProbe(window, workId, memoryRequest, generalMemoryQualityIssue);
  world.generals["probe-general"].status = "captured";
  world.generals["probe-general"].loyalToAccountId = "former-player";
  const captiveRequest = buildGeneralDialogueRequest(world, world.generals["probe-general"], world.players["probe-player"], "你如今身为俘虏，有什么想对我或旧主说？", Date.now());
  const captive = await requestStructuredModelProbe(window, workId, captiveRequest, value => dialogueQualityIssue(value, { captive: true, allowedRecipientKeys: captiveRequest.routing.formerLords.map(item => item.recipientKey) }));
  const conversations = [profile, general, ordinary, memory, captive].map(item => item.conversationId);
  if (new Set(conversations).size !== conversations.length) throw new Error("五个模型探针没有各自创建独立新会话");
  return {
    profile: {
      conversationId: profile.conversationId,
      finishEvent: profile.finishEvent,
      lengths: Object.fromEntries(Object.entries(profile.parsed).map(([key, value]) => [key, String(value || "").length])),
      sample: profile.parsed
    },
    general: {
      conversationId: general.conversationId,
      finishEvent: general.finishEvent,
      name: general.parsed.name,
      gender: general.parsed.gender,
      power: general.parsed.power,
      heightCm: general.parsed.heightCm,
      weightKg: general.parsed.weightKg,
      measurements: general.parsed.measurements,
      appearanceCharacters: String(general.parsed.appearanceSetting || "").length,
      coreSettingCharacters: String(general.parsed.coreSetting || "").length,
      coreSettingSample: String(general.parsed.coreSetting || "").slice(0, 180)
    },
    ordinaryDialogue: { conversationId: ordinary.conversationId, finishEvent: ordinary.finishEvent, replyCharacters: String(ordinary.parsed.reply || "").length, command: ordinary.parsed.command?.type || null },
    memory: { conversationId: memory.conversationId, finishEvent: memory.finishEvent, category: memory.parsed.category, summaryCharacters: String(memory.parsed.summary || "").length, compactMemoryCharacters: String(memory.parsed.compactMemory || "").length },
    captiveDialogue: { conversationId: captive.conversationId, finishEvent: captive.finishEvent, replyCharacters: String(captive.parsed.reply || "").length, command: captive.parsed.command?.type || null },
    distinctConversationCount: new Set(conversations).size
  };
}

function programOnlyReadbackChecks(exported, desired) {
  const actual = normalizeConfiguration(exported);
  return {
    name: actual.app.name === desired.app.name,
    summary: actual.app.summary === desired.app.summary,
    description: actual.app.description === desired.app.description,
    preText: actual.pre_text === desired.pre_text,
    prePrompt: actual.pre_prompt === desired.pre_prompt,
    postText: actual.post_text === desired.post_text,
    worldBooksPreserved: JSON.stringify(actual.world_book) === JSON.stringify(desired.world_book)
  };
}

async function readAllComments(window, workId) {
  const comments = [];
  const seen = new Set();
  for (let page = 1; page <= 200; page += 1) {
    const response = await api(window, `/console/api/comments/${encodeURIComponent(workId)}/1?page=${page}&limit=50&order=desc&filter_type=all`);
    if (!response.ok) throw new Error(`读取控制评论第 ${page} 页失败：HTTP ${response.status}`);
    const pageItems = extractCommentItems(unwrap(response));
    for (const item of pageItems) {
      const id = String(item?.id || item?.comment_id || "");
      if (id && !seen.has(id)) { seen.add(id); comments.push(item); }
    }
    if ((pageItems.rootCount ?? pageItems.length) < 50) break;
  }
  const reader = platformCommentService(window, workId, "");
  return reader.hydrateCommentReplies(comments);
}

function platformCommentService(window, workId, accountId) {
  const service = new OnlineWorldService({
    requestConsole: async (endpoint, options = {}) => {
      const response = await api(window, `/console/api${endpoint}`, options);
      if (!response.ok || (response.payload?.code && response.payload.code !== 100000)) throw new Error(`评论接口失败：HTTP ${response.status}`);
      return unwrap(response);
    },
    getAccount: () => ({ accountId }), cacheFile: null
  });
  service.work = { id: workId, authorAccountId: accountId };
  return service;
}

async function verifySegmentedComments(window, workId) {
  const profile = unwrap(await api(window, "/go/api/account/profile"));
  const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
  if (!accountId) throw new Error("缺少测试账号");
  const service = platformCommentService(window, workId, accountId);
  const record = { schema: FYOW_SCHEMAS.generalDefinition, id: crypto.randomUUID(), gameId: "fyow.protocol-probe", text: `分段回读探针:${crypto.randomBytes(3600).toString("hex")}` };
  const sources = [];
  try {
    sources.push(...await service.postRecord(record));
    const root = sources[0];
    let replies = (await readAllComments(window, workId)).filter(source => decodeCommentChunk(source.content)?.id === record.id);
    let assembled = assembleCommentRecords([root, ...replies]);
    for (let attempt = 0; attempt < 3 && !assembled.records.some(item => item.record.id === record.id); attempt += 1) {
      await sleep(1000);
      replies = (await readAllComments(window, workId)).filter(source => decodeCommentChunk(source.content)?.id === record.id);
      assembled = assembleCommentRecords([root, ...replies]);
    }
    const result = assembled.records.find(item => item.record.id === record.id);
    if (!result || result.record.text !== record.text) throw new Error(`原生回复分段回读不一致：${JSON.stringify({
      chunks: sources.length,
      sent: sources.map(source => ({ id: source.id, author: source.account_id, parent: source.parent_id, chunk: decodeCommentChunk(source.content)?.part, keys: Object.keys(source) })),
      read: replies.map(source => ({ id: source.id, author: source.account_id, parent: source.parent_id, root: source._fyowRootId, chunk: decodeCommentChunk(source.content)?.part, keys: Object.keys(source) })),
      incomplete: assembled.incomplete.map(({ id, received, total }) => ({ id, received, total })), invalid: assembled.invalid,
      branchResponse: await api(window, `/console/api/comments/branches/${encodeURIComponent(root.id)}`),
      pagedBranchResponse: await api(window, `/console/api/comments/branches/${encodeURIComponent(root.id)}?page=1&limit=50`)
    })}`);
    if (!sources.every(source => source.content.length <= 980)) throw new Error("分段超出980字符");
    return { ok: true, chunks: sources.length, largestChunk: Math.max(...sources.map(source => source.content.length)), nativeReplies: replies.filter(source => decodeCommentChunk(source.content)?.id === record.id && decodeCommentChunk(source.content)?.part > 1).length, reconstructedCharacters: result.record.text.length };
  } finally {
    for (const source of [...sources].reverse()) {
      const response = await api(window, `/console/api/comments/${encodeURIComponent(workId)}/1/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      if (!response.ok) process.stderr.write("探针评论清理失败，请检查测试作品。\n");
    }
  }
}

async function verifyRootDeleteGuard(window, workId) {
  const profile = unwrap(await requiredApi(window, "/go/api/account/profile"));
  const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
  if (!accountId) throw new Error("缺少删除保护探针账号");
  const marker = crypto.randomUUID();
  const service = platformCommentService(window, workId, accountId);
  const rootResponse = await service.postComment(`§FYOW-DELETE-GUARD§${marker}§ROOT`);
  const root = findObject(rootResponse, item => Boolean(item.id || item.comment_id));
  const rootId = String(root?.id || root?.comment_id || "");
  if (!rootId) throw new Error("删除保护探针没有返回根评论编号");
  const replyResponse = await service.postComment(`§FYOW-DELETE-GUARD§${marker}§REPLY`, {
    parentId: rootId,
    toAccountId: accountId
  });
  const reply = findObject(replyResponse, item => Boolean(item.id || item.comment_id));
  const replyId = String(reply?.id || reply?.comment_id || "");
  if (!replyId) throw new Error("删除保护探针没有返回回复编号");
  let rootDeleteResponse = null;
  try {
    rootDeleteResponse = await api(window, `/console/api/comments/${encodeURIComponent(workId)}/1/${encodeURIComponent(rootId)}`, { method: "DELETE" });
    await sleep(1000);
    const remaining = (await readAllComments(window, workId))
      .filter(item => [rootId, replyId].includes(String(item?.id || item?.comment_id || "")));
    return {
      rootId,
      replyId,
      rootDeleteAccepted: Boolean(rootDeleteResponse.ok),
      rootDeleteStatus: Number(rootDeleteResponse.status || 0),
      platformRejectsNonEmptyRoot: !rootDeleteResponse.ok,
      remainingIds: remaining.map(item => String(item?.id || item?.comment_id || ""))
    };
  } finally {
    for (const id of [replyId, rootId]) {
      if (!id) continue;
      await api(window, `/console/api/comments/${encodeURIComponent(workId)}/1/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    }
  }
}

async function activateSavedProgram(window, card, workId) {
  const [installedResponse, profileResponse, comments] = await Promise.all([
    api(window, `/console/api/installed-apps/${encodeURIComponent(workId)}`),
    api(window, "/go/api/account/profile"),
    readAllComments(window, workId)
  ]);
  if (!installedResponse.ok || !profileResponse.ok) throw new Error("读取作品作者或当前账号失败");
  const installed = unwrap(installedResponse);
  const profile = unwrap(profileResponse);
  const authorAccountId = String(installed?.app?.created_by_account_id || installed?.created_by_account_id || "");
  const signedInAccountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
  if (!authorAccountId || authorAccountId !== signedInAccountId) throw new Error("当前登录账号不是伴生作品作者");
  const controls = assembleCommentRecords(comments).records
    .filter(item => item.record?.schema === FYOW_SCHEMAS.control && item.record.workId === workId && item.record.authorityAccountId === signedInAccountId)
    .filter(item => verifySignedRecord(item.record, item.record.authoritySigningPublicKey))
    .sort((left, right) => comparePlatformOrder(right, left));
  const current = controls[0]?.record;
  if (!current) throw new Error("评论区没有可更新的作者控制记录");
  const hasOccupationCountingCutover = Number(current.occupationCountingProtocol || 0) >= 1;
  if (current.programHash === card.program.digest && hasOccupationCountingCutover) {
    const matching = controls.filter(item => item.record.programHash === card.program.digest);
    return {
      activated: false,
      alreadyCurrent: true,
      matchingControlIds: matching.map(item => item.record.id),
      duplicateControlsPreserved: Math.max(0, matching.length - 1)
    };
  }
  const identity = loadOnlineWorldIdentity(signedInAccountId);
  if (identity.signingPublicKey !== current.authoritySigningPublicKey) throw new Error("本机设备密钥与当前赛季控制记录不一致");
  const updatedAt = Date.now();
  const unsigned = {
    ...current,
    id: crypto.randomUUID(),
    programHash: card.program.digest,
    updatedAt,
    occupationCountingProtocol: 1,
    occupationCountingFrom: hasOccupationCountingCutover ? current.occupationCountingFrom : updatedAt
  };
  delete unsigned.signature;
  const updated = signRecord(unsigned, identity.signingPrivateKey);
  await platformCommentService(window, workId, signedInAccountId).postRecord(updated);
  let verified = false;
  let verificationDiagnostic = null;
  for (let attempt = 0; attempt < 10 && !verified; attempt += 1) {
    await sleep(1000);
    const commentItems = await readAllComments(window, workId);
    const records = assembleCommentRecords(commentItems).records;
    verified = records.some(item => item.record?.id === updated.id
      && item.record.programHash === card.program.digest && verifySignedRecord(item.record, identity.signingPublicKey));
    verificationDiagnostic = { comments: commentItems.length, controls: records.filter(item => item.record?.schema === FYOW_SCHEMAS.control).map(item => ({ id: item.record.id, programHash: item.record.programHash })) };
  }
  if (!verified) throw new Error(`程序控制记录发布后回读校验失败：${JSON.stringify(verificationDiagnostic)}`);
  return { activated: true, alreadyCurrent: false, controlId: updated.id };
}

function findObject(root, predicate) {
  const queue = [root];
  const seen = new Set();
  while (queue.length && seen.size < 2000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value) && predicate(value)) return value;
    queue.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return null;
}

async function requiredApi(window, pathname, options = {}, attempts = 12) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await api(window, pathname, options);
    if (response.ok) return response;
    last = response;
    const message = String(response.payload?.message || response.payload?.msg || response.payload?.raw || "");
    const rateLimited = response.status === 429 || /频繁|too many|rate.?limit|429/i.test(message);
    if (!rateLimited && response.status < 500) break;
    await sleep(Math.min(5 * 60_000, 15_000 * (2 ** Math.min(4, attempt))));
  }
  throw new Error(`平台接口失败：${pathname} HTTP ${last?.status || 0} ${last?.payload?.message || last?.payload?.msg || ""}`.trim());
}

function persistProvisionState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

async function assertUnopenedWork(window, workId) {
  const response = await requiredApi(window, `/console/api/comments/${encodeURIComponent(workId)}/1?page=1&limit=50&order=created_at_desc&filter_type=all`);
  const comments = extractCommentItems(unwrap(response));
  if (comments.length) throw new Error(`新伴生作品 ${workId} 已存在 ${comments.length} 条评论，未保持未开服状态`);
}

async function provisionServerCards(window, requestedCount) {
  const additionalCount = Math.max(1, Math.min(20, Number.parseInt(requestedCount, 10) || 4));
  const cardsDirectory = path.resolve(__dirname, "../game-cards");
  const baseCardFile = path.join(cardsDirectory, "猎艳疆土.json");
  const baseCard = validateGameCard(JSON.parse(fs.readFileSync(baseCardFile, "utf8")));
  const resumeFile = path.resolve(__dirname, "../tmp/grid-companion-server-provision.json");
  let resume = { schema: "fyow.grid-server-provision/1", basePackageSha256: baseCard.packageSha256, servers: [] };
  if (fs.existsSync(resumeFile)) {
    const parsed = JSON.parse(fs.readFileSync(resumeFile, "utf8"));
    if (parsed?.schema === resume.schema && parsed?.basePackageSha256 === baseCard.packageSha256) resume = parsed;
  }
  const profile = unwrap(await requiredApi(window, "/go/api/account/profile"));
  const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
  if (!accountId || accountId !== baseCard.companion.authorAccountId) throw new Error("当前账号不是游戏卡登记的作品作者");

  const completed = [];
  for (let offset = 0; offset < additionalCount; offset += 1) {
    const slot = offset + 2;
    let entry = resume.servers.find(item => Number(item.slot) === slot) || null;
    if (!entry) {
      const createdResponse = await requiredApi(window, "/console/api/apps", {
        method: "POST",
        body: {
          name: `猎艳疆土·${slot}服（未开服）`,
          description: baseCard.companion.configuration.app.description,
          icon: "",
          icon_background: "",
          mode: "chat",
          type: 1
        }
      });
      const created = unwrap(createdResponse);
      const createdApp = findObject(created, item => /^[0-9a-z-]{8,80}$/i.test(String(item.id || item.app_id || item.appId || "")));
      const workId = String(created?.app?.id || created?.data?.app?.id || created?.id || created?.app_id
        || createdApp?.id || createdApp?.app_id || createdApp?.appId || "");
      if (!workId) throw new Error(`创建第 ${slot} 服后平台没有返回作品编号`);
      entry = { slot, workId, createdAt: new Date().toISOString(), configured: false, verified: false };
      resume.servers.push(entry);
      persistProvisionState(resumeFile, resume);
      await sleep(3000);
    }

    const workId = String(entry.workId);
    const targetName = `猎艳疆土·${slot}服[${workId.replace(/[^0-9a-z]/gi, "").slice(0, 16)}]`;
    const desired = JSON.parse(JSON.stringify(baseCard.companion.configuration));
    desired.app.id = workId;
    desired.app.name = targetName;
    if (!entry.configured) {
      const modelResponse = await requiredApi(window, `/go/api/apps/config?app_id=${encodeURIComponent(workId)}`);
      const model = findObject(unwrap(modelResponse), item => typeof item.provider === "string" && typeof (item.name || item.model) === "string");
      if (!model) throw new Error(`第 ${slot} 服没有返回模型配置`);
      const payload = modelConfigSavePayload(desired, workId, targetName, desired.app.description, model);
      payload.app.is_available_not_public = true;
      payload.app.schedule_publish_or_not = false;
      await requiredApi(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config`, { method: "POST", body: payload });
      entry.configured = true;
      persistProvisionState(resumeFile, resume);
      await sleep(3000);
    }

    const exportedResponse = await requiredApi(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
    const verifiedConfig = exportedConfig(unwrap(exportedResponse));
    const expectedPayload = modelConfigSavePayload(desired, workId, targetName, desired.app.description,
      findObject(verifiedConfig, item => typeof item.provider === "string" && typeof (item.name || item.model) === "string") || {});
    if (!coreConfigMatches(verifiedConfig, expectedPayload)) throw new Error(`第 ${slot} 服创作配置或世界书回读不一致`);
    await assertUnopenedWork(window, workId);

    const rebound = rebindGameCard(baseCard, workId, ORIGIN);
    const card = createExportedGameCard(rebound, verifiedConfig);
    const cardFile = path.join(cardsDirectory, `猎艳疆土-${slot}服.json`);
    const temporaryCardFile = `${cardFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryCardFile, `${JSON.stringify(card, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryCardFile, cardFile);
    entry.configured = true;
    entry.verified = true;
    entry.name = targetName;
    entry.cardFile = path.relative(path.resolve(__dirname, ".."), cardFile).replace(/\\/g, "/");
    entry.packageSha256 = card.packageSha256;
    entry.verifiedAt = new Date().toISOString();
    persistProvisionState(resumeFile, resume);
    completed.push({ slot, workId, name: targetName, cardFile: entry.cardFile, packageSha256: card.packageSha256, unopened: true });
    await sleep(2000);
  }
  return { accountId, baseCard: path.relative(path.resolve(__dirname, ".."), baseCardFile).replace(/\\/g, "/"), servers: completed };
}

async function main() {
  const bundledCard = createBundledGridCard();
  const requestedWorkId = String(process.env.FYOW_COMPANION_WORK_ID || "").trim();
  const card = requestedWorkId ? rebindGameCard(bundledCard, requestedWorkId, ORIGIN) : bundledCard;
  const workId = card.companion.workId;
  let desired = card.companion.configuration;
  const platformSession = session.fromPartition(`fyow-configure-grid-${Date.now()}`, { cache: false });
  await platformSession.setProxy({ mode: "system" });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session: platformSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  try {
    await login(window, loadCredentials());
    if (process.env.FYOW_PROBE_ROOT_DELETE_GUARD === "1") {
      const result = await verifyRootDeleteGuard(window, workId);
      process.stdout.write(`${JSON.stringify({ ok: true, workId, result }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_PROVISION_SERVER_CARDS) {
      const result = await provisionServerCards(window, process.env.FYOW_PROVISION_SERVER_CARDS);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_DIAGNOSE_DEPLOYMENTS === "1") {
      const service = new OnlineWorldService({
        requestConsole: async (endpoint, options = {}) => {
          if (options.method && options.method !== "GET") throw new Error("Read-only ledger diagnosis");
          const response = await api(window, `/console/api${endpoint}`, options);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return unwrap(response);
        },
        getAccount: () => ({}), getOrigin: () => ORIGIN, cacheFile: null, onChange: () => {}
      });
      service.work = { id: workId, authorAccountId: card.companion.authorAccountId };
      service.commentReadSession = { pages: new Map(), branches: new Map(), comments: new Map(), failedRoots: new Map(), totalRoots: null };
      const history = await service.readHistory(true);
      const records = history.assembled.records;
      const directory = path.join(__dirname, "../release-cache/deployment-diagnosis");
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `ledger-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify({ work: service.work, records, incomplete: history.assembled.incomplete }, null, 2));
      const cells = new Set(["25,9", "16,3"]);
      process.stdout.write(`${JSON.stringify({
        file, history: service.history,
        controls: service.verifiedControls(records).map(item => ({ ...recordPlatformOrder(item), ...item.record })),
        changes: records.filter(item => Object.keys(item.record.changes?.cells || {}).some(key => cells.has(key)))
          .sort(comparePlatformOrder).map(item => ({
            mapDeltaId: item.record.mapDeltaId, actor: item.record.actorAccountId, order: recordPlatformOrder(item),
            cells: item.record.changes.cells, cellBases: item.record.changes.cellBases,
            generals: Object.fromEntries(Object.entries(item.record.changes.generals || {}).map(([id, general]) => [id,
              general && { id, name: general.name, status: general.status, holderAccountId: general.holderAccountId, location: general.location }])),
            transitions: item.record.changes.generalTransitions
          }))
      }, null, 2)}\n`);
      service.close();
      return;
    }
    if (process.env.FYOW_RESTORE_DEPLOYED_GENERAL === "1") {
      const targetAccountId = String(process.env.FYOW_RESTORE_TARGET_ACCOUNT_ID || "").trim();
      const targetAccountName = String(process.env.FYOW_RESTORE_TARGET_ACCOUNT_NAME || "").trim();
      const generalId = String(process.env.FYOW_RESTORE_GENERAL_ID || "").trim();
      const sourceMapDeltaId = String(process.env.FYOW_RESTORE_SOURCE_MAP_DELTA_ID || "").trim();
      const sourceRootId = String(process.env.FYOW_RESTORE_SOURCE_ROOT_ID || "").trim();
      const removalMapDeltaId = String(process.env.FYOW_RESTORE_REMOVAL_MAP_DELTA_ID || "").trim();
      const removalRootId = String(process.env.FYOW_RESTORE_REMOVAL_ROOT_ID || "").trim();
      const targetX = Number(process.env.FYOW_RESTORE_X);
      const targetY = Number(process.env.FYOW_RESTORE_Y);
      const apply = process.env.FYOW_RESTORE_APPLY === "1";
      const verifyOnly = process.env.FYOW_RESTORE_VERIFY_ONLY === "1";
      if (!targetAccountId || !targetAccountName || !generalId || !sourceMapDeltaId || !sourceRootId || !removalMapDeltaId || !removalRootId
        || !Number.isInteger(targetX) || !Number.isInteger(targetY)) throw new Error("恢复参数不完整");
      const profileResponse = await api(window, "/go/api/account/profile");
      if (!profileResponse.ok) throw new Error(`读取当前账号失败：HTTP ${profileResponse.status}`);
      const profile = unwrap(profileResponse);
      const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
      const username = String(profile?.name || profile?.username || profile?.email || "服主");
      const makeService = () => new OnlineWorldService({
        requestConsole: async (endpoint, options) => {
          const response = await api(window, `/console/api${endpoint}`, options);
          if (!response.ok) throw new Error(response.payload?.message || response.payload?.msg || `平台接口失败：${endpoint} HTTP ${response.status}`);
          return unwrap(response);
        },
        requestGo: async (endpoint, options) => {
          const response = await api(window, `/go/api${endpoint}`, options);
          if (!response.ok) throw new Error(`作品页面接口失败：${endpoint} HTTP ${response.status}`);
          return unwrap(response);
        },
        requestModel: async () => { throw new Error("将领恢复不应调用模型"); },
        getAccount: () => ({ accountId, username }),
        getIdentity: async () => loadOnlineWorldIdentity(accountId),
        getOrigin: () => ORIGIN,
        cacheFile: null,
        onChange: () => {}
      });
      const readExactRecord = async (service, rootId, recordId) => {
        const tailPage = Math.max(1, Number(service.historyTailPage || 1));
        for (let page = 1; page <= tailPage; page += 1) {
          const comments = await service.readHistoryPage(page);
          const root = comments.find(item => String(item?.id || item?.comment_id || "") === rootId);
          if (!root) continue;
          const branches = await service.readCommentBranches(rootId, 100, { rootComment: root });
          const records = assembleCommentRecords([root, ...branches]).records;
          const item = records.find(candidate => String(candidate.record?.mapDeltaId || candidate.record?.id || "") === recordId);
          if (!item) throw new Error(`评论 ${rootId} 没有组装出记录 ${recordId}`);
          return item;
        }
        throw new Error(`没有找到来源评论 ${rootId}`);
      };
      const service = makeService();
      let verifier = null;
      try {
        const opened = await service.open({ card, displayName: username, orientation: "any" });
        if (!opened.initialized || !opened.isAuthority || accountId !== service.work?.authorAccountId) throw new Error("当前账号或设备不是这个服务器的服主");
        await service.syncNow(true);
        const sourceItem = await readExactRecord(service, sourceRootId, sourceMapDeltaId);
        const removalItem = await readExactRecord(service, removalRootId, removalMapDeltaId);
        if (!service.validMapDelta(sourceItem) || !service.validMapDelta(removalItem)) throw new Error("来源部署或移除记录未通过当前签名与结构校验");
        const sourceRecord = sourceItem.record;
        const removalRecord = removalItem.record;
        const key = `${targetX},${targetY}`;
        const sourceGeneral = sourceRecord.changes?.generals?.[generalId];
        const sourceCell = sourceRecord.changes?.cells?.[key];
        const removalCell = removalRecord.changes?.cells?.[key];
        const currentPlayer = service.world?.players?.[targetAccountId];
        const currentCell = service.world?.cells?.[key];
        const currentEpoch = Math.max(0, Math.trunc(Number(service.world?.playerEpochs?.[targetAccountId] || 0)));
        const conflicts = {
          currentGeneral: Boolean(service.world?.generals?.[generalId]),
          cells: Object.entries(service.world?.cells || {}).filter(([, cell]) => (cell?.generalIds || []).map(String).includes(generalId)).map(([cellKey]) => cellKey),
          listings: Object.entries(service.world?.marketListings || {}).filter(([, listing]) => String(listing?.generalId || listing?.general?.id || "") === generalId).map(([listingId]) => listingId),
          sales: Object.entries(service.world?.marketSales || {}).filter(([, sale]) => String(sale?.generalId || sale?.general?.id || "") === generalId).map(([saleId]) => saleId)
        };
        if (!currentPlayer || (targetAccountName && String(currentPlayer.accountName || "") !== targetAccountName)) throw new Error("目标玩家身份与恢复目标不一致");
        if (!currentCell || String(currentCell.ownerAccountId || "") !== targetAccountId) throw new Error("恢复格子当前已不属于目标玩家");
        if ((currentCell.generalIds || []).length >= 2) throw new Error("恢复格子的驻守将领已满");
        if (sourceRecord.actorAccountId !== targetAccountId || Number(sourceRecord.playerEpoch || 0) !== currentEpoch
          || !sourceGeneral || String(sourceGeneral.id || "") !== generalId || String(sourceGeneral.holderAccountId || "") !== targetAccountId
          || sourceGeneral.status !== "deployed" || Number(sourceGeneral.location?.x) !== targetX || Number(sourceGeneral.location?.y) !== targetY
          || !sourceCell || String(sourceCell.ownerAccountId || "") !== targetAccountId || !(sourceCell.generalIds || []).map(String).includes(generalId)) {
          throw new Error("原始部署记录与目标玩家、纪元或坐标不一致");
        }
        if (removalRecord.actorAccountId !== targetAccountId || Number(removalRecord.playerEpoch || 0) !== currentEpoch
          || removalRecord.changes?.generals?.[generalId] !== null || !removalCell
          || (removalCell.generalIds || []).map(String).includes(generalId)
          || comparePlatformOrder(sourceItem, removalItem) >= 0) throw new Error("后续移除记录与恢复证据链不一致");
        const currentGeneralOrder = service.publicGeneralOrders?.[generalId] || {};
        const removalOrder = recordPlatformOrder(removalItem);
        if (Number(currentGeneralOrder.timestamp || 0) !== Number(removalOrder.timestamp || 0)
          || String(currentGeneralOrder.commentId || "") !== String(removalOrder.commentId || "")) throw new Error("该将领在来源移除记录之后仍有其他公开变更");
        const restoredGeneral = JSON.parse(JSON.stringify(sourceGeneral));
        restoredGeneral.status = "deployed";
        restoredGeneral.location = { x: targetX, y: targetY };
        restoredGeneral.holderAccountId = targetAccountId;
        restoredGeneral.experienceUpdatedAt = service.now();
        ensureGeneralProfile(restoredGeneral);
        const expectedPublicGeneral = publicGeneralState(restoredGeneral);
        if (verifyOnly) {
          const currentGeneral = service.world?.generals?.[generalId] || null;
          const currentPublicGeneral = currentGeneral ? publicGeneralState(currentGeneral) : null;
          process.stdout.write(`${JSON.stringify({
            ok: Boolean(currentGeneral
              && currentGeneral.status === "deployed"
              && String(currentGeneral.holderAccountId || "") === targetAccountId
              && Number(currentGeneral.location?.x) === targetX
              && Number(currentGeneral.location?.y) === targetY
              && (currentCell.generalIds || []).map(String).includes(generalId)),
            workId,
            seasonId: service.control.seasonId,
            revision: service.world.revision,
            general: currentGeneral ? {
              id: currentGeneral.id,
              name: currentGeneral.name,
              status: currentGeneral.status,
              location: currentGeneral.location,
              holderAccountId: currentGeneral.holderAccountId,
              power: currentGeneral.power,
              interactionCount: Array.isArray(currentGeneral.interactionHistory) ? currentGeneral.interactionHistory.length : 0,
              memoryEntryCount: Array.isArray(currentGeneral.memory?.entries) ? currentGeneral.memory.entries.length : 0,
              memoryCharacters: String(currentGeneral.memoryText || "").length,
              archiveSha256: crypto.createHash("sha256").update(canonicalJson(currentPublicGeneral)).digest("hex"),
              sourceArchiveSha256: crypto.createHash("sha256").update(canonicalJson(expectedPublicGeneral)).digest("hex")
            } : null,
            cell: currentCell,
            conflicts
          }, null, 2)}\n`);
          return;
        }
        if (conflicts.currentGeneral || conflicts.cells.length || conflicts.listings.length || conflicts.sales.length) throw new Error(`当前世界存在同 ID 冲突：${JSON.stringify(conflicts)}`);
        const before = {
          revision: Number(service.world.revision || 0),
          playerEpoch: currentEpoch,
          player: JSON.parse(JSON.stringify(currentPlayer)),
          cell: JSON.parse(JSON.stringify(currentCell)),
          publicGeneralOrder: service.publicGeneralOrders?.[generalId] || null
        };
        const preview = {
          apply,
          workId,
          seasonId: service.control.seasonId,
          targetAccountId,
          targetAccountName: currentPlayer.accountName,
          targetDisplayName: currentPlayer.displayName,
          target: { x: targetX, y: targetY },
          general: {
            id: restoredGeneral.id,
            name: restoredGeneral.name,
            power: restoredGeneral.power,
            interactionCount: Array.isArray(restoredGeneral.interactionHistory) ? restoredGeneral.interactionHistory.length : 0,
            memoryEntryCount: Array.isArray(restoredGeneral.memory?.entries) ? restoredGeneral.memory.entries.length : 0,
            memoryCharacters: String(restoredGeneral.memoryText || "").length,
            archiveSha256: crypto.createHash("sha256").update(canonicalJson(expectedPublicGeneral)).digest("hex")
          },
          source: { mapDeltaId: sourceMapDeltaId, rootId: sourceRootId, order: recordPlatformOrder(sourceItem) },
          removal: { mapDeltaId: removalMapDeltaId, rootId: removalRootId, order: recordPlatformOrder(removalItem) },
          before
        };
        if (!apply) {
          process.stdout.write(`${JSON.stringify({ ok: true, preview }, null, 2)}\n`);
          return;
        }
        const auditDirectory = path.join(process.cwd(), "output", "general-recovery", new Date().toISOString().replace(/[:.]/g, "-"));
        fs.mkdirSync(auditDirectory, { recursive: true });
        const cachePath = path.join(app.getPath("userData"), "online-world", "cache", `${PROFILE_ID}.json`);
        if (fs.existsSync(cachePath)) fs.copyFileSync(cachePath, path.join(auditDirectory, `${PROFILE_ID}.json.before`));
        service.world.generals[generalId] = restoredGeneral;
        currentCell.generalIds = [...new Set([...(currentCell.generalIds || []).map(String), generalId])];
        service.world.revision = before.revision + 1;
        const snapshot = await service.publishSnapshot();
        fs.writeFileSync(path.join(auditDirectory, "recovery.json"), JSON.stringify({ preview, snapshotId: snapshot.snapshotId, restoredGeneral }, null, 2));
        await sleep(1500);
        verifier = makeService();
        let verifiedState = await verifier.open({ card, displayName: username, orientation: "any" });
        let verifiedGeneral = null;
        let verifiedCell = null;
        let verifiedArchiveSha256 = null;
        let verified = false;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          if (attempt) verifiedState = await verifier.syncNow(true);
          verifiedGeneral = verifier.world?.generals?.[generalId];
          verifiedCell = verifier.world?.cells?.[key];
          verifiedArchiveSha256 = verifiedGeneral
            ? crypto.createHash("sha256").update(canonicalJson(verifiedGeneral)).digest("hex") : null;
          verified = Boolean(verifiedState.initialized && verifiedGeneral && verifiedGeneral.status === "deployed"
            && String(verifiedGeneral.holderAccountId || "") === targetAccountId
            && (verifiedCell?.generalIds || []).map(String).includes(generalId)
            && verifiedArchiveSha256 === preview.general.archiveSha256);
          if (verified) break;
          await sleep(3000);
        }
        if (!verified) throw new Error("恢复快照发布后平台回读校验不一致");
        process.stdout.write(`${JSON.stringify({
          ok: true,
          applied: true,
          workId,
          seasonId: service.control.seasonId,
          snapshotId: snapshot.snapshotId,
          revision: verifier.world.revision,
          auditDirectory,
          general: preview.general,
          cell: { key, ownerAccountId: verifiedCell.ownerAccountId, generalIds: verifiedCell.generalIds },
          verification: { status: verifiedState.status, archiveSha256: verifiedArchiveSha256 }
        }, null, 2)}\n`);
      } finally {
        verifier?.close();
        service.close();
      }
      return;
    }
    if (process.env.FYOW_PROBE_REPLY === "1") {
      const profile = unwrap(await api(window, "/go/api/account/profile"));
      const accountId = String(profile?.id || "");
      const target = `/console/api/comments/${workId}/1`;
      const sent = [];
      try {
        const root = unwrap(await api(window, target, { method: "POST", body: { content: `FYOW分支回读测试 ${crypto.randomUUID()}`, biz_type: 1, is_anonymous: false } }));
        const rootComment = extractCommentItems(root)[0];
        if (!rootComment) throw new Error("没有根评论");
        sent.push(rootComment);
        const bodies = [
          { parent_id: rootComment.id, to_account_id: accountId },
          { parent_id: rootComment.id },
          { parent_id: rootComment.id, to_account_id: accountId, to_comment_id: rootComment.id }
        ];
        for (let index = 0; index < bodies.length; index++) {
          const response = await api(window, target, { method: "POST", body: { ...bodies[index], content: `FYOW短回复测试-${index}`, biz_type: 1, is_anonymous: false } });
          sent.push(...extractCommentItems(unwrap(response)));
        }
        await sleep(2000);
        const listing = [];
        for (let page = 1; page < 40; page++) {
          const response = await api(window, `${target}?page=${page}&limit=100&order=desc&filter_type=all`);
          const items = extractCommentItems(unwrap(response));
          listing.push(...items.filter(item => sent.some(source => source.id === item.id)));
          if (items.length < 100) break;
        }
        const result = {
          root: rootComment.id,
          sent: sent.map(item => ({ id: item.id, content: item.content, keys: Object.keys(item) })),
          branch: await api(window, `/console/api/comments/branches/${rootComment.id}?_t=${Date.now()}`),
          rootDetail: listing
        };
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        for (const item of sent.reverse()) await api(window, `${target}/${item.id}`, { method: "DELETE" });
      }
      return;
    }
    if (process.env.FYOW_INSPECT_COMMENT_CLIENT === "1") {
      await load(window, `/zh/explore/installed/${workId}`);
      await sleep(2000);
      const result = await window.webContents.executeJavaScript(`(async () => {
        const hits = [];
        for (const url of [...new Set([...document.scripts].map(script => script.src).filter(Boolean))]) {
          const source = await fetch(url).then(response => response.text()).catch(() => '');
          if (!source.includes('AppComment') && !source.includes('getComments') && !source.includes('fetchComments')) continue;
          for (const needle of ['AppComment','getComments','fetchComments']) {
            let from = 0;
            for (let count = 0; count < 5; count++) {
              const index = source.indexOf(needle,from);
              if(index < 0) break;
              hits.push({url,needle,snippet:source.slice(Math.max(0,index-150),index+2500)});
              from=index+needle.length;
            }
          }
        }
        return hits;
      })()`, true);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_INSPECT_HISTORY === "1") {
      const requests = [];
      const service = new OnlineWorldService({
        requestConsole: async (endpoint, options) => {
          requests.push(endpoint);
          const response = await api(window, `/console/api${endpoint}`, options);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return unwrap(response);
        },
        getAccount: () => ({}), getOrigin: () => ORIGIN, cacheFile: null, onChange: () => {}
      });
      service.work = { id: workId, authorAccountId: card.companion.authorAccountId };
      service.commentReadSession = { pages: new Map(), branches: new Map(), comments: new Map(), failedRoots: new Map(), totalRoots: null };
      service.loadProgress = { active: true, phase: "reading", readComments: 0, totalComments: null };
      const startedAt = Date.now();
      const history = await service.readHistory(true);
      const control = service.verifiedControls(history.assembled.records)[0]?.record;
      process.stdout.write(`${JSON.stringify({
        history: service.history, requests: requests.length, elapsedMs: Date.now() - startedAt, progress: service.loadProgress,
        incomplete: history.assembled.incomplete.map(item => ({ kind: item.kind, id: item.id, received: item.received, total: item.total,
          createdAt: item.sources[0]?.created_at })),
        invalid: history.assembled.invalid,
        snapshots: service.verifiedSnapshots(history.assembled.records, control).slice(0, 3).map(item => ({
          id: item.id, order: recordPlatformOrder(item), through: item.record.ledgerCoverage?.through,
          pendingIncluded: history.assembled.incomplete.filter(partial => item.record.ledgerCoverage?.appliedMapDeltaIds?.includes(partial.id)).map(partial => partial.id)
        }))
      }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_PROBE_SEGMENTS === "1") {
      process.stdout.write(`${JSON.stringify(await verifySegmentedComments(window, workId), null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_PROBE_AUTO_MODEL === "1") {
      process.stdout.write(`${JSON.stringify(await runAutomaticModelProbe(window, workId), null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_MIGRATE_ACTIVE === "1") {
      const profileResponse = await api(window, "/go/api/account/profile");
      if (!profileResponse.ok) throw new Error(`读取当前账号失败：HTTP ${profileResponse.status}`);
      const profile = unwrap(profileResponse);
      const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
      const username = String(profile?.name || profile?.username || profile?.email || "服主");
      const service = new OnlineWorldService({
        requestConsole: async (endpoint, options) => {
          const response = await api(window, `/console/api${endpoint}`, options);
          if (!response.ok) throw new Error(response.payload?.message || response.payload?.msg || `平台接口失败：${endpoint} HTTP ${response.status}`);
          return unwrap(response);
        },
        requestModel: async () => { throw new Error("搬迁不应调用模型"); },
        getAccount: () => ({ accountId, username }),
        getIdentity: async () => loadOnlineWorldIdentity(accountId),
        getOrigin: () => ORIGIN,
        cacheFile: null,
        onChange: () => {}
      });
      try {
        const opened = await service.open({ card, displayName: username, orientation: "any" });
        if (!opened.initialized || !opened.isAuthority) throw new Error("当前账号或设备不是这个服务器的服主");
        const migration = await service.exportMigrationDraft();
        process.stdout.write(`${JSON.stringify({ ok: Boolean(migration.redirectPublished), fromWorkId: workId, migration }, null, 2)}\n`);
      } finally {
        service.close();
      }
      return;
    }
    if (process.env.FYOW_LINK_MIGRATION_TARGET) {
      const targetWorkId = String(process.env.FYOW_LINK_MIGRATION_TARGET).trim();
      const profileResponse = await api(window, "/go/api/account/profile");
      if (!profileResponse.ok) throw new Error(`读取当前账号失败：HTTP ${profileResponse.status}`);
      const profile = unwrap(profileResponse);
      const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
      const username = String(profile?.name || profile?.username || profile?.email || "服主");
      const targetConfigResponse = await api(window, `/console/api/apps/${encodeURIComponent(targetWorkId)}/model-config/export`);
      if (!targetConfigResponse.ok) throw new Error(`读取搬迁目标配置失败：HTTP ${targetConfigResponse.status}`);
      const targetConfig = findConfig(unwrap(targetConfigResponse));
      const targetDescription = String(targetConfig?.desc ?? targetConfig?.descr ?? targetConfig?.dsc ?? targetConfig?.intro ?? targetConfig?.description ?? targetConfig?.app?.description ?? "");
      const targetProgram = parseProgram(targetDescription, card.gameId);
      if (!targetProgram || targetProgram.digest !== bundledCard.program.digest) throw new Error("搬迁目标尚未安装本次游戏程序");
      const targetInstalledResponse = await api(window, `/console/api/installed-apps/${encodeURIComponent(targetWorkId)}`);
      if (!targetInstalledResponse.ok) throw new Error(`读取搬迁目标失败：HTTP ${targetInstalledResponse.status}`);
      const targetInstalled = unwrap(targetInstalledResponse);
      const targetApp = targetInstalled?.app || targetInstalled;
      if (String(targetApp?.created_by_account_id || "") !== accountId) throw new Error("搬迁目标不属于当前服主账号");
      if (assembleCommentRecords(await readAllComments(window, targetWorkId)).records.some(item => item.record?.schema === FYOW_SCHEMAS.control)) throw new Error("搬迁目标已经存在游戏账本");
      const service = new OnlineWorldService({
        requestConsole: async (endpoint, options) => {
          const response = await api(window, `/console/api${endpoint}`, options);
          if (!response.ok) throw new Error(response.payload?.message || response.payload?.msg || `平台接口失败：${endpoint} HTTP ${response.status}`);
          return unwrap(response);
        },
        requestModel: async () => { throw new Error("搬迁不应调用模型"); },
        getAccount: () => ({ accountId, username }),
        getIdentity: async () => loadOnlineWorldIdentity(accountId),
        getOrigin: () => ORIGIN,
        cacheFile: null,
        onChange: () => {}
      });
      try {
        const opened = await service.open({ card, displayName: username, orientation: "any" });
        if (!opened.initialized || !opened.isAuthority) throw new Error("当前账号或设备不是来源服务器的服主");
        service.migrationActive = true;
        await Promise.allSettled([service.syncInFlight, service.intentInFlight, service.joinInFlight].filter(Boolean));
        await service.syncNow(true, { ignoreMigrationReset: true });
        if (!service.control || !service.world || !service.isAuthority()) throw new Error("来源服务器最新账本尚未完成权威校验");
        const identity = await service.getIdentity();
        const oldWork = service.work;
        const oldControl = service.control;
        const sourceConfigResponse = await api(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
        if (!sourceConfigResponse.ok) throw new Error(`读取来源配置失败：HTTP ${sourceConfigResponse.status}`);
        const exportSha256 = crypto.createHash("sha256").update(canonicalJson(findConfig(unwrap(sourceConfigResponse)))).digest("hex");
        const newWork = {
          ...oldWork,
          id: targetWorkId,
          name: String(targetApp?.name || oldWork.name),
          description: targetDescription,
          url: `${ORIGIN}/zh/explore/installed/${encodeURIComponent(targetWorkId)}`,
          authorAccountId: accountId
        };
        const migrationId = crypto.randomUUID();
        const newControlUnsigned = {
          ...oldControl,
          id: crypto.randomUUID(),
          workId: targetWorkId,
          programHash: bundledCard.program.digest,
          migrationId,
          migrationSourceWorkId: oldWork.id,
          updatedAt: service.now()
        };
        delete newControlUnsigned.signature;
        const newControl = signRecord(newControlUnsigned, identity.signingPrivateKey);
        service.migrationDraft = {
          migrationId,
          sourceWorkId: oldWork.id,
          sourceControlId: oldControl.id,
          sourceSeasonId: oldControl.seasonId,
          sourceProgramHash: oldControl.programHash,
          sourceLedgerRuntime: service.captureLedgerRuntimeState(),
          newWorkId: targetWorkId,
          newWorkUrl: newWork.url,
          targetName: newWork.name,
          targetDescription: newWork.description,
          exportSha256,
          configurationImported: true,
          oldWorkRenameAttempted: true,
          oldWorkRenamed: false,
          targetControl: newControl,
          targetControlPosted: false,
          targetSnapshot: null,
          targetSnapshotId: "",
          targetLedgerInitialized: false,
          targetLedgerVerified: false,
          targetSourceWatermark: "",
          sourceFinalizedAfterReset: false,
          resetPublished: false,
          resetId: crypto.randomUUID(),
          resetIssuedAt: service.now()
        };
        const migration = await service.completeMigrationDraft(service.migrationDraft, null, oldWork, oldControl);
        const complete = migration?.redirectPublished === true
          && migration?.targetLedgerVerified === true
          && migration?.cleanupPending === false
          && migration?.requiresPublish !== true
          && migration?.requiresConfigurationImport !== true
          && String(migration?.workId || "") === targetWorkId;
        if (!complete) {
          const detail = migration?.importError
            || migration?.cleanup?.failures?.[0]?.error
            || "目标账本、源服稳定水位或旧评论清理尚未完成";
          throw new Error(`搬迁未完成：${detail}`);
        }
        process.stdout.write(`${JSON.stringify({ ok: true, fromWorkId: oldWork.id, workId: targetWorkId, url: newWork.url, controlId: newControl.id, resetId: migration.resetId, programDigest: bundledCard.program.digest, cleanup: migration.cleanup }, null, 2)}\n`);
      } finally {
        service.close();
      }
      return;
    }
    if (process.env.FYOW_INSPECT_MODELS === "1") {
      const response = await api(window, "/go/api/workspaces/model-list");
      if (!response.ok) throw new Error(`读取模型列表失败：HTTP ${response.status}`);
      const catalog = unwrap(response);
      const { normalizeCatalog, rankModels } = require("../electron/auto-model-router.cjs");
      const models = rankModels(normalizeCatalog(catalog));
      process.stdout.write(`${JSON.stringify({ count: models.length, tiers: [0, 1, 2].map(tier => ({ tier, count: models.filter(item => item.priority === tier).length })), first: models.slice(0, 15).map(({ label, provider, price, successRate, latency, priority }) => ({ label, provider, price, successRate, latency, priority })) }, null, 2)}\n`);
      return;
    }
    await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
    if (process.env.FYOW_INSPECT_AUTHOR === "1") {
      const [installedResponse, profileResponse] = await Promise.all([
        api(window, `/console/api/installed-apps/${encodeURIComponent(workId)}`),
        api(window, "/go/api/account/profile")
      ]);
      if (!installedResponse.ok) throw new Error(`读取作品作者失败：HTTP ${installedResponse.status}`);
      const installed = unwrap(installedResponse);
      const profile = unwrap(profileResponse);
      const authorAccountId = String(installed?.app?.created_by_account_id || "");
      const signedInAccountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
      process.stdout.write(`${JSON.stringify({ ok:true, status:installedResponse.status, workId, authorAccountId, signedInAccountId, signedInIsAuthor:Boolean(authorAccountId && authorAccountId === signedInAccountId), rootKeys:installed && typeof installed === "object" ? Object.keys(installed) : [], identityFields:identityFieldPaths(installed) }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_INSPECT_COMMENT_PAGES === "1") {
      const pages = [];
      for (const [order, page] of [["created_at_desc", 1], ["created_at_desc", 2]]) {
        const response = await api(window, `/console/api/comments/${encodeURIComponent(workId)}/1?page=${page}&limit=50&order=${order}&filter_type=all`);
        const payload = unwrap(response);
        const items = extractCommentItems(payload);
        const roots = items.filter(item => !item._fyowRootId);
        const times = roots.map(item => Number(item.created_at || 0));
        pages.push({
          order,
          page,
          ok: response.ok,
          status: response.status,
          itemCount: items.length,
          rootCount: roots.length,
          descending: times.every((value, index) => !index || times[index - 1] >= value),
          ascending: times.every((value, index) => !index || times[index - 1] <= value),
          rootTimes: times,
          firstCreatedAt: items[0]?.created_at || null,
          lastCreatedAt: items.at(-1)?.created_at || null,
          newestCreatedAt: Math.max(0, ...items.map(item => Number(item?.created_at || 0))),
          oldestCreatedAt: Math.min(...items.map(item => Number(item?.created_at || 0)).filter(Boolean)),
          controlIds: assembleCommentRecords(items).records.filter(item => item.record?.schema === FYOW_SCHEMAS.control).map(item => item.record.id),
          shape: shapeOf(payload)
        });
      }
      process.stdout.write(`${JSON.stringify({ ok:true, workId, pages }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_VERIFY_SYNC === "1") {
      const profileResponse = await api(window, "/go/api/account/profile");
      if (!profileResponse.ok) throw new Error(`读取当前账号失败：HTTP ${profileResponse.status}`);
      const profile = unwrap(profileResponse);
      const accountId = String(profile?.id || profile?.account_id || profile?.accountId || "");
      const username = String(profile?.name || profile?.username || profile?.email || "测试账号");
      const service = new OnlineWorldService({
        requestConsole: async (endpoint, options) => {
          const response = await api(window, `/console/api${endpoint}`, options);
          if (!response.ok) throw new Error(`同步接口失败：${endpoint} HTTP ${response.status}`);
          return unwrap(response);
        },
        requestGo: async (endpoint, options) => {
          const response = await api(window, `/go/api${endpoint}`, options);
          if (!response.ok) throw new Error(`作品页面接口失败：${endpoint} HTTP ${response.status}`);
          return unwrap(response);
        },
        requestModel: async () => { throw new Error("只读同步校验不应调用模型"); },
        getAccount: () => ({ accountId, username }),
        getIdentity: async () => loadOnlineWorldIdentity(accountId),
        getOrigin: () => ORIGIN,
        cacheFile: null,
        onChange: () => {}
      });
      let state;
      try {
        state = await service.open({ card });
      } catch (error) {
        const platformComments = await readAllComments(window, workId).catch(() => []);
        const platformControls = assembleCommentRecords(platformComments).records
          .filter(item => item.record?.schema === FYOW_SCHEMAS.control)
          .sort((left, right) => comparePlatformOrder(right, left))
          .slice(0, 8)
          .map(item => ({ id: item.record.id, programHash: item.record.programHash, sources: item.sources.map(source => ({ id: source.id, createdAt: source.created_at })) }));
        process.stderr.write(`${JSON.stringify({
          event: "sync-verification-diagnostic",
          error: String(error?.message || error),
          cardProgramHash: card.program.digest,
          controlId: service.control?.id || null,
          controlProgramHash: service.control?.programHash || null,
          loadedProgramHash: service.program?.digest || null,
          history: service.history,
          platformCommentCount: platformComments.length,
          platformControls
        })}\n`);
        throw error;
      }
      service.close();
      process.stdout.write(`${JSON.stringify({ ok:true, workId, status:state.status, history:state.history, controlProgramHash:state.control?.programHash || null, currentProgramHash:state.program?.digest || null, revision:state.revision }, null, 2)}\n`);
      return;
    }
    const beforeResponse = await api(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
    if (!beforeResponse.ok) throw new Error(`读取创作配置失败：HTTP ${beforeResponse.status}`);
    const before = findConfig(unwrap(beforeResponse));
    if (process.env.FYOW_INSPECT_META === "1") {
      const installedResponse = await api(window, `/console/api/installed-apps/${encodeURIComponent(workId)}`);
      const installed = unwrap(installedResponse);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        workId,
        exported: Object.fromEntries(Object.entries(before || {}).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))),
        installed: installed?.app || installed
      }, null, 2)}\n`);
      return;
    }
    const programOnly = process.env.FYOW_PROGRAM_ONLY === "1";
    if (programOnly) {
      desired = normalizeConfiguration(before, card.companion);
      desired.app.description = card.companion.configuration.app.description;
    }
    const checkReadback = programOnly ? programOnlyReadbackChecks : readbackChecks;
    if (process.env.FYOW_INSPECT) {
      const count = Math.max(1, Math.min(30, Number.parseInt(process.env.FYOW_INSPECT, 10) || 1));
      const samples = [before];
      for (let index = 1; index < count; index += 1) {
        const response = await api(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
        if (response.ok) samples.push(findConfig(unwrap(response)));
        await sleep(100);
      }
      process.stdout.write(`${JSON.stringify({ roles:[...new Set(samples.map(value => JSON.stringify(roleKeys(value, desired))))].map(value => JSON.parse(value)), exported:shapeOf(samples[0]), app:shapeOf(samples[0]?.app) }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_PROBE_MODEL === "1") {
      const probe = await runModelProbe(window, workId);
      process.stdout.write(`${JSON.stringify({ ok:true, workId, probe }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_PROBE_POINTS === "1") {
      const before = await readPlatformPointBalance(window);
      const request = buildPlayerProfileContextRequest({ displayName: "积分探针", basicInfo: "慧眼之主", appearance: "黑发" }, crypto.randomUUID());
      const probe = await requestStructuredModelProbe(window, workId, request, playerContextQualityIssue);
      const after = await readPlatformPointBalance(window);
      process.stdout.write(`${JSON.stringify({ ok:true, workId, before:before.points, after:after.points, consumed:Number.isFinite(before.points) && Number.isFinite(after.points) ? Math.max(0, before.points - after.points) : null, modelPoints:probe.points, usage:probe.usage, conversationId:probe.conversationId, finishEvent:probe.finishEvent }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_VERIFY_ONLY === "1") {
      const checks = checkReadback(before, desired);
      if (!Object.values(checks).every(value => value === true || value === desired.world_book.length)) throw new Error(`创作配置回读不一致：${JSON.stringify(checks)}`);
      process.stdout.write(`${JSON.stringify({ ok:true, workId, page:`${ORIGIN}/zh/app/${workId}/configuration`, verifiedStatus:beforeResponse.status, checks, descriptionCharacters:desired.app.description.length, programDigest:card.program.digest, configurationSha256:configurationDigest(before) }, null, 2)}\n`);
      return;
    }
    if (process.env.FYOW_CAPTURE_UI === "1") {
      const uiTemplate = await captureUiSaveTemplate(window, platformSession, desired, workId);
      process.stdout.write(`${JSON.stringify({ payload:shapeOf(uiTemplate), app:shapeOf(uiTemplate?.app) }, null, 2)}\n`);
      return;
    }
    const uiTemplate = await captureUiSaveTemplate(window, platformSession, desired, workId);
    const payload = toSavePayload({ ...before, ...uiTemplate }, desired);
    const saveResponse = await api(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config`, { method: "POST", body: payload });
    if (!saveResponse.ok) {
      const diagnostic = {
        exported: shapeOf(before),
        app: shapeOf(before?.app),
        response: saveResponse.payload
      };
      throw new Error(`保存创作配置失败：HTTP ${saveResponse.status} ${saveResponse.payload?.message || saveResponse.payload?.msg || ""} ${JSON.stringify(diagnostic)}`.trim());
    }
    await sleep(1000);
    const verifyResponse = await api(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
    if (!verifyResponse.ok) throw new Error(`回读创作配置失败：HTTP ${verifyResponse.status}`);
    const verified = findConfig(unwrap(verifyResponse));
    const checks = checkReadback(verified, desired);
    if (!Object.values(checks).every(value => value === true || value === desired.world_book.length)) {
      throw new Error(`保存后回读不一致：${JSON.stringify({ checks, exported: shapeOf(verified), app: shapeOf(verified?.app) })}`);
    }
    const activation = process.env.FYOW_ACTIVATE_PROGRAM === "1" ? await activateSavedProgram(window, card, workId) : null;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      workId,
      page: `${ORIGIN}/zh/app/${workId}/configuration`,
      savedStatus: saveResponse.status,
      verifiedStatus: verifyResponse.status,
      checks,
      descriptionCharacters: desired.app.description.length,
      programDigest: card.program.digest,
      configurationSha256: configurationDigest(desired),
      activation
    }, null, 2)}\n`);
  } finally {
    window.destroy();
    await platformSession.clearStorageData().catch(() => {});
  }
}

app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => app.quit()).catch(error => {
  console.error(error?.message || String(error));
  app.exit(1);
});
