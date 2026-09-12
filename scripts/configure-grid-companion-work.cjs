"use strict";

const { app, BrowserWindow, safeStorage, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { readJsonWithBackupSync } = require("../electron/runtime-utils.cjs");
const { createBundledGridCard, configurationDigest } = require("../electron/online-world-card.cjs");

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

async function main() {
  const card = createBundledGridCard();
  const workId = card.companion.workId;
  const desired = card.companion.configuration;
  const platformSession = session.fromPartition(`fyow-configure-grid-${Date.now()}`, { cache: false });
  await platformSession.setProxy({ mode: "system" });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session: platformSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  try {
    await login(window, loadCredentials());
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
    const beforeResponse = await api(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
    if (!beforeResponse.ok) throw new Error(`读取创作配置失败：HTTP ${beforeResponse.status}`);
    const before = findConfig(unwrap(beforeResponse));
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
    if (process.env.FYOW_VERIFY_ONLY === "1") {
      const checks = readbackChecks(before, desired);
      if (!Object.values(checks).every(value => value === true || value === 2)) throw new Error(`创作配置回读不一致：${JSON.stringify(checks)}`);
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
    const checks = readbackChecks(verified, desired);
    if (!Object.values(checks).every(value => value === true || value === 2)) {
      throw new Error(`保存后回读不一致：${JSON.stringify({ checks, exported: shapeOf(verified), app: shapeOf(verified?.app) })}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      workId,
      page: `${ORIGIN}/zh/app/${workId}/configuration`,
      savedStatus: saveResponse.status,
      verifiedStatus: verifyResponse.status,
      checks,
      descriptionCharacters: desired.app.description.length,
      programDigest: card.program.digest,
      configurationSha256: configurationDigest(desired)
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
