const { app, BrowserWindow, session } = require("electron");

const ORIGIN = String(process.env.FYOW_TEST_ORIGIN || "https://aigirlfriend.baby").replace(/\/$/, "");
const MODE = String(process.argv.find(value => value.startsWith("--mode="))?.slice(7) || "inspect");
const TIMEOUT_MS = 20_000;
const CREATOR_PROBE = Object.freeze({
  name: "FYOW 在线游戏世界接口联调",
  description: [
    '<section data-fyow-program-manifest="fyow.program/1">',
    '<pre data-fyow-program="base64url">ZXhwb3J0IGRlZmF1bHQge21vdW50KCl7cmV0dXJuICJGWU9XLUNSRUFUT1ItUFJPQkUtVjEiO319</pre>',
    '</section>'
  ].join(""),
  preText: "[[FYOW:PRE:probe:v1]]",
  postText: "[[FYOW:POST:probe:v1]]",
  prompt: [
    "你是 FYOW 在线游戏世界接口联调路由器。",
    "只处理形如 [[FYOW:TASK:probe:v1]] 的测试请求。",
    '命中后只返回一行 JSON：{"schema":"fyow.model-response/1","ok":true,"probe":"creator-save"}'
  ].join("\n"),
  worldBookKeyword: "[[FYOW:TASK:probe:v1]]",
  worldBookContent: '这是用户输入触发的联调世界书。固定返回：{"worldBook":"matched","version":1}'
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function load(window, pathname) {
  await window.loadURL(`${ORIGIN}${pathname}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (window.webContents.isLoading() && Date.now() < deadline) await sleep(100);
  if (window.webContents.isLoading()) throw new Error(`页面加载超时：${pathname}`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await window.webContents.executeJavaScript("document.body && document.body.innerText.trim().length > 12", true).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
}

async function login(window, account, password) {
  await load(window, "/zh/signin");
  const submitted = await window.webContents.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let accountInput;
    let passwordInput;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      accountInput = document.querySelector('#email,input[autocomplete="username"],input[placeholder*="邮箱"],input[placeholder*="用户名"]');
      passwordInput = document.querySelector('#password,input[autocomplete="current-password"],input[type="password"]');
      if (accountInput && passwordInput) break;
      await sleep(100);
    }
    if (!accountInput || !passwordInput) return { ok:false, reason:'missing-login-form' };
    const setValue = (element, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(element, value);
      element.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value }));
      element.dispatchEvent(new Event('change', { bubbles:true }));
    };
    setValue(accountInput, ${JSON.stringify(account)});
    setValue(passwordInput, ${JSON.stringify(password)});
    await sleep(150);
    const form = passwordInput.closest('form') || accountInput.closest('form');
    const submit = form?.querySelector('button[type="submit"],input[type="submit"]')
      || [...document.querySelectorAll('button')].find(button => /^(登录|登錄|Sign in)$/i.test((button.textContent || '').trim()));
    if (!submit) return { ok:false, reason:'missing-submit' };
    submit.click();
    return { ok:true };
  })()`, true);
  if (!submitted?.ok) throw new Error(`平台登录表单提交失败：${submitted?.reason || "unknown"}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    if (window.webContents.isLoading()) continue;
    const status = await window.webContents.executeJavaScript(`(() => ({
      authenticated: Boolean(localStorage.getItem('console_token')),
      path: location.pathname,
      error: [...document.querySelectorAll('[role="alert"],[class*="error" i],[class*="invalid" i]')]
        .map(element => (element.textContent || '').replace(/\\s+/g, ' ').trim())
        .find(text => text && /错误|失败|无效|不存在|密码|频繁|验证|error|invalid|failed/i.test(text)) || null
    }))()`, true).catch(() => ({ authenticated: false }));
    if (status.authenticated) return { path: status.path };
    if (status.error) throw new Error(`平台登录失败：${status.error}`);
  }
  throw new Error("平台登录验证超时");
}

async function inspectPage(window, pathname) {
  await load(window, pathname);
  return inspectCurrentPage(window);
}

async function inspectCurrentPage(window) {
  return window.webContents.executeJavaScript(`(() => ({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 5000),
    links: [...document.querySelectorAll('a[href]')].map(a => ({ text:(a.textContent || '').replace(/\\s+/g, ' ').trim(), href:a.href })).filter(x => x.text || /app|create|work/i.test(x.href)).slice(0, 200),
    textTargets: ['创作','高级创作','简易创作','发送消息','评论'].map(label => {
      const element = [...document.querySelectorAll('body *')].find(node => node.children.length === 0 && (node.textContent || '').trim() === label);
      return element ? { label, tag:element.tagName, outer:element.outerHTML.slice(0, 1200), parent:element.parentElement?.outerHTML.slice(0, 1600) || null } : { label, missing:true };
    }),
    controls: [...document.querySelectorAll('button,input,textarea,[role="button"],[role="tab"]')].map((element, index) => ({
      index,
      tag:element.tagName,
      type:element.getAttribute('type'),
      name:element.getAttribute('name'),
      id:element.id,
      placeholder:element.getAttribute('placeholder'),
      text:(element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
    })).slice(0, 300)
  }))()`, true);
}

async function clickExactText(window, label) {
  let clicked = false;
  for (let attempt = 0; attempt < 80 && !clicked; attempt += 1) {
    clicked = await window.webContents.executeJavaScript(`(() => {
      const label = ${JSON.stringify(label)};
      const leaves = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && (node.textContent || '').trim() === label);
      const leaf = leaves.find(node => node.getClientRects().length) || leaves[leaves.length - 1];
      const target = leaf?.closest('a,button,[role="button"],[class*="cursor-pointer"]') || leaf?.parentElement;
      if (!target) return false;
      target.click();
      return true;
    })()`, true).catch(() => false);
    if (!clicked) await sleep(100);
  }
  if (!clicked) throw new Error(`找不到可点击文字：${label}`);
  await sleep(1500);
}

async function inspectWorldBookEditor(window) {
  return window.webContents.executeJavaScript(`(() => {
    const compact = element => element ? {
      tag: element.tagName,
      id: element.id || null,
      text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      html: element.outerHTML.slice(0, 5000)
    } : null;
    const exact = label => [...document.querySelectorAll('body *')]
      .find(node => node.children.length === 0 && (node.textContent || '').trim() === label);
    return {
      worldBookTab: compact(exact('世界书设置')?.closest('[role="tab"],button,[class*="cursor-pointer"]') || exact('世界书设置')),
      add: compact(exact('+ 新增')?.closest('button,[role="button"],[class*="cursor-pointer"]') || exact('+ 新增')),
      keywordInputs: [...document.querySelectorAll('input[placeholder*="关键词"],input[placeholder*="正则表达式"]')].map(compact),
      contentInputs: [...document.querySelectorAll('textarea')].filter(node => /世界书内容/.test(node.placeholder || '')).map(compact),
      userLabels: [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && (node.textContent || '').trim() === '用户').map(node => compact(node.closest('button,[role="button"],[class*="cursor-pointer"]') || node)).slice(0, 20),
      nearbyButtons: [...document.querySelectorAll('button,[role="button"]')].map(compact).filter(item => /新增|用户|关键词|世界书|值/.test(item.text)).slice(0, 80)
    };
  })()`, true);
}

async function authenticatedJson(window, pathname, options = {}) {
  return window.webContents.executeJavaScript(`(async () => {
    const token = localStorage.getItem('console_token') || '';
    if (!token) throw new Error('missing-token');
    const response = await fetch(${JSON.stringify(pathname)}, {
      method:${JSON.stringify(options.method || "GET")},
      credentials:'include',
      cache:'no-store',
      headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json','X-Language':'zh-Hans'},
      ${options.body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(options.body))},`}
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw:text.slice(0, 2000) }; }
    return { ok:response.ok, status:response.status, payload };
  })()`, true);
}

function unwrapPayload(response) {
  const payload = response?.payload;
  return payload?.code === 100000 ? payload.data : (payload?.data ?? payload);
}

function findObject(root, predicate) {
  const queue = [root];
  const seen = new Set();
  while (queue.length && seen.size < 2000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (predicate(value)) return value;
    if (Array.isArray(value)) queue.push(...value);
    else queue.push(...Object.values(value));
  }
  return null;
}

async function createIsolatedClient(label, account, password) {
  const isolatedSession = session.fromPartition(`fyow-live-${label}-${Date.now()}`, { cache:false });
  await isolatedSession.setProxy({ mode:"system" });
  const window = new BrowserWindow({
    show:false,
    webPreferences:{
      session: isolatedSession,
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      backgroundThrottling:false
    }
  });
  try {
    await login(window, account, password);
    return { window, isolatedSession };
  } catch (error) {
    window.destroy();
    await isolatedSession.clearStorageData().catch(() => {});
    throw error;
  }
}

async function runCommunications(accountAWindow, workId) {
  const accountB = requiredEnvironment("FYOW_TEST_ACCOUNT_B");
  const passwordB = requiredEnvironment("FYOW_TEST_PASSWORD_B");
  const clientB = await createIsolatedClient("account-b", accountB, passwordB);
  const marker = `FYOW-COMMS-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const rootText = `[${marker}] 自动联调评论：comment-root`;
  const replyText = `[${marker}] 自动联调回复：comment-reply`;
  const directText = `[${marker}] 自动联调私信：direct-message`;
  const commentPath = `/console/api/comments/${encodeURIComponent(workId)}/1`;
  try {
    const [profileAResponse, profileBResponse] = await Promise.all([
      authenticatedJson(accountAWindow, "/go/api/account/profile"),
      authenticatedJson(clientB.window, "/go/api/account/profile")
    ]);
    const profileA = unwrapPayload(profileAResponse) || {};
    const profileB = unwrapPayload(profileBResponse) || {};
    const accountAId = String(profileA.id ?? profileA.account_id ?? profileA.accountId ?? "");
    const accountBId = String(profileB.id ?? profileB.account_id ?? profileB.accountId ?? "");
    if (!accountAId || !accountBId) throw new Error("平台账号资料缺少账号编号");

    const rootResponse = await authenticatedJson(accountAWindow, commentPath, {
      method:"POST",
      body:{ is_anonymous:false, biz_type:1, content:rootText }
    });
    if (!rootResponse.ok) throw new Error(`发送评论失败：HTTP ${rootResponse.status} ${rootResponse.payload?.message || ""}`.trim());
    let rootComment = findObject(unwrapPayload(rootResponse), value => String(value?.content || "") === rootText);
    for (let attempt = 0; attempt < 8 && !rootComment; attempt += 1) {
      await sleep(250 + attempt * 100);
      const list = await authenticatedJson(clientB.window, `${commentPath}?page=1&limit=50&order=newest&filter_type=all`);
      rootComment = findObject(unwrapPayload(list), value => String(value?.content || "") === rootText);
    }
    const rootCommentId = String(rootComment?.id ?? rootComment?.comment_id ?? "");
    if (!rootCommentId) throw new Error("评论已提交，但另一个账号没有读取到评论编号");

    const replyResponse = await authenticatedJson(clientB.window, commentPath, {
      method:"POST",
      body:{ is_anonymous:false, parent_id:rootCommentId, to_account_id:accountAId, biz_type:1, content:replyText }
    });
    if (!replyResponse.ok) throw new Error(`回复评论失败：HTTP ${replyResponse.status} ${replyResponse.payload?.message || ""}`.trim());
    let replyComment = findObject(unwrapPayload(replyResponse), value => String(value?.content || "") === replyText);
    for (let attempt = 0; attempt < 8 && !replyComment; attempt += 1) {
      await sleep(250 + attempt * 100);
      const branches = await authenticatedJson(accountAWindow, `/console/api/comments/branches/${encodeURIComponent(rootCommentId)}`);
      replyComment = findObject(unwrapPayload(branches), value => String(value?.content || "") === replyText);
    }
    if (!replyComment) throw new Error("回复已提交，但发起账号没有在评论分支中读取到回复");

    let chatsResponse = await authenticatedJson(clientB.window, "/console/api/chats?page=1&limit=500");
    let chat = findObject(unwrapPayload(chatsResponse), value => String(value?.other_account?.id || "") === accountAId && value?.id);
    if (!chat) {
      const createChat = await authenticatedJson(clientB.window, "/console/api/chats", { method:"POST", body:{ receive_id:accountAId } });
      if (!createChat.ok) throw new Error(`建立私信会话失败：HTTP ${createChat.status} ${createChat.payload?.message || ""}`.trim());
      chat = findObject(unwrapPayload(createChat), value => value?.id && (value?.other_account || value?.receive_id));
      for (let attempt = 0; attempt < 8 && !chat; attempt += 1) {
        await sleep(250 + attempt * 100);
        chatsResponse = await authenticatedJson(clientB.window, "/console/api/chats?page=1&limit=500");
        chat = findObject(unwrapPayload(chatsResponse), value => String(value?.other_account?.id || "") === accountAId && value?.id);
      }
    }
    const chatId = String(chat?.id || "");
    if (!chatId) throw new Error("平台没有返回私信会话编号");
    const sendDirect = await authenticatedJson(clientB.window, "/console/api/chats/messages", { method:"POST", body:{ chat_id:chatId, content:directText } });
    if (!sendDirect.ok) throw new Error(`发送私信失败：HTTP ${sendDirect.status} ${sendDirect.payload?.message || ""}`.trim());
    let receivedDirect = null;
    for (let attempt = 0; attempt < 10 && !receivedDirect; attempt += 1) {
      await sleep(300 + attempt * 100);
      const accountAChats = await authenticatedJson(accountAWindow, "/console/api/chats?page=1&limit=500");
      const accountAChat = findObject(unwrapPayload(accountAChats), value => String(value?.other_account?.id || "") === accountBId && value?.id);
      if (!accountAChat?.id) continue;
      const messages = await authenticatedJson(accountAWindow, `/console/api/chats/messages?chat_id=${encodeURIComponent(accountAChat.id)}&page=1&limit=100`);
      receivedDirect = findObject(unwrapPayload(messages), value => String(value?.content || "") === directText);
    }
    if (!receivedDirect) throw new Error("私信已提交，但接收账号没有读取到测试私信");

    return {
      workId,
      marker,
      accounts:{ a:{ id:accountAId, name:profileA.name || profileA.username || null }, b:{ id:accountBId, name:profileB.name || profileB.username || null } },
      comment:{ sent:true, id:rootCommentId, readByOtherAccount:true },
      reply:{ sent:true, id:String(replyComment.id ?? replyComment.comment_id ?? ""), readByOtherAccount:true },
      directMessage:{ chatId, sent:true, readByOtherAccount:true }
    };
  } finally {
    clientB.window.destroy();
    await clientB.isolatedSession.clearStorageData().catch(() => {});
  }
}

async function runModelProbe(window, workId) {
  await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
  const query = `${CREATOR_PROBE.worldBookKeyword}\n{"schema":"fyow.model-request/1","input":{"probe":"world-book"}}`;
  return window.webContents.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const query = ${JSON.stringify(query)};
    window.__fyowModelRequests = [];
    if (!window.__fyowModelFetchWrapped) {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        if (method !== 'GET') window.__fyowModelRequests.push({ method, url:String(url), body:String(init?.body || '').slice(0, 8000) });
        const response = await originalFetch(input, init);
        if (/chat-messages/.test(String(url))) response.clone().text().then(text => { window.__fyowModelRaw = text; }).catch(error => { window.__fyowModelRawError = error?.message || String(error); });
        return response;
      };
      window.__fyowModelFetchWrapped = true;
    }
    const beforeQuestions = document.querySelectorAll('#customized-question-content').length;
    const beforeAnswers = document.querySelectorAll('#ai-chat-answer').length;
    for (let attempt = 0; attempt < 150 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(100);
    const input = document.querySelector('#ai-chat-input');
    if (!input || !document.querySelector('#ai-send-button')) throw new Error('创作调试区没有出现模型输入控件');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, query);
    input.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:query }));
    input.dispatchEvent(new Event('change', { bubbles:true }));
    await sleep(200);
    if (input.value !== query) throw new Error('模型测试文本没有写入输入框');
    const readySend = document.querySelector('#ai-send-button');
    if (!readySend || readySend.disabled || readySend.getAttribute('aria-disabled') === 'true') throw new Error('模型发送按钮尚未就绪');
    HTMLElement.prototype.click.call(readySend);
    const deadline = Date.now() + 90000;
    let answer = '';
    let questionCreated = false;
    while (Date.now() < deadline) {
      questionCreated = document.querySelectorAll('#customized-question-content').length > beforeQuestions;
      const answers = [...document.querySelectorAll('#ai-chat-answer')];
      if (answers.length > beforeAnswers) answer = (answers.at(-1)?.innerText || answers.at(-1)?.textContent || '').trim();
      const stop = [...document.querySelectorAll('div.absolute.bottom-2.right-2 > div[role="presentation"].bg-black.cursor-pointer')]
        .find(element => !element.id && element.querySelector('svg') && !element.querySelector('input,textarea')) || null;
      const requestSent = window.__fyowModelRequests.some(request => /chat-messages/.test(request.url));
      const sendReady = Boolean(document.querySelector('#ai-send-button'));
      if (requestSent && questionCreated && answer && !stop && sendReady && window.__fyowModelRaw) break;
      const errorText = [...document.querySelectorAll('[role="alert"],[data-sonner-toast]')]
        .map(element => (element.textContent || '').replace(/\\s+/g, ' ').trim())
        .find(text => /失败|错误|异常|不足|频繁|error|failed/i.test(text));
      if (errorText) throw new Error('模型请求失败：' + errorText);
      await sleep(200);
    }
    const modelRequest = window.__fyowModelRequests.find(request => /chat-messages/.test(request.url)) || null;
    if (!modelRequest) throw new Error('平台发送按钮没有产生模型网络请求');
    if (!questionCreated) throw new Error('平台没有建立模型测试消息');
    if (!answer) throw new Error('模型请求已发送，但没有返回正文');
    let conversationId = null;
    try {
      const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
      const stored = map[${JSON.stringify(workId)}];
      conversationId = typeof stored === 'string' ? stored : stored?.conversationId || stored?.conversation_id || stored?.id || null;
    } catch {}
    return {
      sent:true,
      query,
      conversationId,
      answer:answer.slice(0, 2000),
      request:{ method:modelRequest.method, url:modelRequest.url },
      rawResponse:String(window.__fyowModelRaw || '').slice(0, 8000),
      worldBookMarkerObserved:/worldBook|matched|命中/i.test(answer)
    };
  })()`, true);
}

async function inspectPersistedModelProbe(window, workId) {
  const query = `${CREATOR_PROBE.worldBookKeyword}\n{"schema":"fyow.model-request/1","input":{"probe":"world-book"}}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const conversationsResponse = await authenticatedJson(window, `/console/api/installed-apps/${encodeURIComponent(workId)}/conversations?limit=20`);
    const conversationsRoot = unwrapPayload(conversationsResponse);
    const conversationObjects = [];
    const queue = [conversationsRoot];
    const seen = new Set();
    while (queue.length && seen.size < 1000) {
      const value = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (!Array.isArray(value) && (value.id || value.conversation_id) && (value.name || value.created_at || value.updated_at)) conversationObjects.push(value);
      if (Array.isArray(value)) queue.push(...value);
      else queue.push(...Object.values(value));
    }
    const unique = [...new Map(conversationObjects.map(item => [String(item.id || item.conversation_id), item])).values()];
    for (const conversation of unique.slice(0, 5)) {
      const conversationId = String(conversation.id || conversation.conversation_id || "");
      if (!conversationId) continue;
      const messagesResponse = await authenticatedJson(window, `/console/api/installed-apps/${encodeURIComponent(workId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=20&page=1&paging_query_sort=desc`);
      const record = findObject(unwrapPayload(messagesResponse), value => String(value?.query || "").includes(CREATOR_PROBE.worldBookKeyword) && typeof value?.answer === "string");
      if (record) return {
        found:true,
        conversationId,
        messageId:String(record.id || record.message_id || ""),
        query:record.query,
        answer:String(record.answer || "").slice(0, 4000),
        worldBookMarkerObserved:/worldBook|matched|命中/i.test(String(record.answer || ""))
      };
    }
    await sleep(500 + attempt * 150);
  }
  return { found:false, query };
}

async function configureAndSaveCreatorProbe(window, workId) {
  const outcome = await window.webContents.executeJavaScript(`(async () => {
    const probe = ${JSON.stringify(CREATOR_PROBE)};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => Boolean(element && element.getClientRects().length);
    const byPlaceholder = text => {
      const candidates = [...document.querySelectorAll('input,textarea')].filter(element => (element.placeholder || '').includes(text));
      return candidates.find(visible) || candidates[candidates.length - 1] || null;
    };
    window.__fyowProbeRequests = [];
    if (!window.__fyowProbeFetchWrapped) {
      const originalFetch = window.fetch.bind(window);
      window.__fyowProbeOriginalFetch = originalFetch;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        if (method !== 'GET') window.__fyowProbeRequests.push({ transport:'fetch', method, url:String(url), body:String(init?.body || '').slice(0, 12000) });
        if (method === 'POST' && /\\/console\\/api\\/apps\\/[^/]+\\/model-config/.test(String(url))) {
          return new Response(JSON.stringify({ result:'联调程序已捕获创作页保存载荷' }), { status:200, headers:{ 'Content-Type':'application/json' } });
        }
        return originalFetch(input, init);
      };
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) { this.__fyowMethod = method; this.__fyowUrl = url; return originalOpen.call(this, method, url, ...rest); };
      XMLHttpRequest.prototype.send = function(body) {
        if (String(this.__fyowMethod || 'GET').toUpperCase() !== 'GET') window.__fyowProbeRequests.push({ transport:'xhr', method:String(this.__fyowMethod), url:String(this.__fyowUrl), body:String(body || '').slice(0, 12000) });
        return originalSend.call(this, body);
      };
      window.__fyowProbeFetchWrapped = true;
    }
    const setValue = (element, value) => {
      if (!element) throw new Error('缺少创作字段');
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
      element.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value }));
      element.dispatchEvent(new Event('change', { bubbles:true }));
      element.dispatchEvent(new Event('blur', { bubbles:true }));
      const propsKey = Object.keys(element).find(key => key.startsWith('__reactProps$'));
      const props = propsKey ? element[propsKey] : null;
      if (typeof props?.onChange === 'function') props.onChange({ target:element, currentTarget:element, type:'change', persist() {}, preventDefault() {}, stopPropagation() {} });
    };
    const exactButtons = label => [...document.querySelectorAll('button,[role="button"]')]
      .filter(element => (element.textContent || '').replace(/\\s+/g, ' ').trim() === label);
    for (let attempt = 0; attempt < 100 && !byPlaceholder('给你的作品起个名字'); attempt += 1) await sleep(100);
    const basicFields = {
      name: byPlaceholder('给你的作品起个名字'),
      description: byPlaceholder('<div class="custom-ui">'),
      preText: byPlaceholder('严格遵循回复示例'),
      postText: byPlaceholder('使用优化小说文风'),
      prompt: byPlaceholder('-我的世界观内容是')
    };
    const missingFields = Object.entries(basicFields).filter(([, element]) => !element).map(([name]) => name);
    if (missingFields.length) throw new Error('缺少创作字段：' + missingFields.join(','));
    setValue(basicFields.name, probe.name);
    setValue(basicFields.description, probe.description);
    setValue(basicFields.preText, probe.preText);
    setValue(basicFields.postText, probe.postText);
    setValue(basicFields.prompt, probe.prompt);
    await sleep(300);
    const worldBookTabs = [...document.querySelectorAll('button[role="tab"]')].filter(button => (button.textContent || '').trim() === '世界书设置');
    const worldBookTab = worldBookTabs.find(visible) || worldBookTabs[worldBookTabs.length - 1];
    if (worldBookTab) HTMLElement.prototype.click.call(worldBookTab);
    await sleep(500);
    let content = [...document.querySelectorAll('textarea[placeholder="在此处填写世界书内容"]')].at(-1) || null;
    if (!content) {
      const addButtons = exactButtons('+ 新增');
      const add = addButtons.find(visible) || addButtons[addButtons.length - 1];
      if (add) HTMLElement.prototype.click.call(add);
      for (let attempt = 0; attempt < 40 && !content; attempt += 1) {
        await sleep(100);
        content = [...document.querySelectorAll('textarea[placeholder="在此处填写世界书内容"]')].at(-1) || null;
      }
    }
    if (!content) throw new Error('新增世界书条目后没有出现内容编辑器');

    const entry = content.closest('[class*="border"],section,article') || content.parentElement?.parentElement?.parentElement || document.body;
    const keywordCandidates = [...document.querySelectorAll('input')].filter(input => /触发关键词/.test(input.placeholder || ''));
    const keyword = keywordCandidates.find(input => /填写触发关键词后/.test(input.placeholder || '')) || keywordCandidates.at(-1);
    setValue(keyword, probe.worldBookKeyword);
    keyword.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
    keyword.dispatchEvent(new KeyboardEvent('keyup', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
    await sleep(200);
    setValue(content, probe.worldBookContent);
    const entryIndex = [...document.querySelectorAll('textarea[placeholder="在此处填写世界书内容"]')].indexOf(content);
    const userToggle = document.getElementById(entryIndex + '-key-2')
      || [...document.querySelectorAll('button[id$="-key-2"][role="checkbox"]')].find(button => entry.contains(button));
    if (!userToggle) throw new Error('世界书条目缺少“用户”触发开关');
    if (userToggle.getAttribute('aria-checked') !== 'true') userToggle.click();
    await sleep(200);
    const saveButtons = exactButtons('保存');
    const save = saveButtons.find(visible) || saveButtons[saveButtons.length - 1];
    if (!save) throw new Error('找不到作品保存按钮');
    save.scrollIntoView({ block:'center' });
    save.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerId:1, isPrimary:true }));
    save.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, button:0 }));
    save.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1, isPrimary:true }));
    save.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, button:0 }));
    HTMLElement.prototype.click.call(save);
    const savePropsKey = Object.keys(save).find(key => key.startsWith('__reactProps$'));
    const saveProps = savePropsKey ? save[savePropsKey] : null;
    let directSaveError = null;
    if (!window.__fyowProbeRequests.length && typeof saveProps?.onClick === 'function') {
      try {
        await saveProps.onClick({ target:save, currentTarget:save, type:'click', persist() {}, preventDefault() {}, stopPropagation() {} });
      } catch (error) {
        directSaveError = error?.message || String(error);
      }
    }
    let confirmationClicked = false;
    for (let attempt = 0; attempt < 50 && !confirmationClicked; attempt += 1) {
      const dialogs = [...document.querySelectorAll('[role="dialog"],[data-slot="dialog-content"]')].filter(visible);
      const dialog = dialogs.at(-1);
      const confirm = dialog ? [...dialog.querySelectorAll('button')].find(button => /^(确认|确定|Confirm)$/i.test((button.textContent || '').trim())) : null;
      if (confirm) {
        HTMLElement.prototype.click.call(confirm);
        confirmationClicked = true;
        break;
      }
      await sleep(100);
    }
    const deadline = Date.now() + 15000;
    let notice = null;
    let errorNotice = null;
    while (Date.now() < deadline) {
      const notices = [...document.querySelectorAll('[role="status"],[role="alert"],[data-sonner-toast],[class*="toast" i]')]
        .map(element => (element.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(text => text && text.length < 240);
      notice = notices.find(text => /保存成功|已保存|作品已更新|修改成功/.test(text)) || null;
      errorNotice = notices.find(text => /失败|错误|必填|不能为空|请上传|请选择|XSS/.test(text)) || null;
      if (notice || errorNotice) break;
      await sleep(100);
    }
    return {
      clicked:true,
      notice,
      errorNotice,
      userTrigger: userToggle.getAttribute('aria-checked'),
      keyword: probe.worldBookKeyword,
      descriptionCharacters: probe.description.length,
      values: {
        name: byPlaceholder('给你的作品起个名字')?.value || null,
        description: byPlaceholder('<div class="custom-ui">')?.value || null,
        preText: byPlaceholder('严格遵循回复示例')?.value || null,
        postText: byPlaceholder('使用优化小说文风')?.value || null,
        prompt: byPlaceholder('-我的世界观内容是')?.value || null,
        keyword: keyword?.value || null,
        content: content?.value || null
      },
      invalid: [...document.querySelectorAll('[aria-invalid="true"],:invalid')].map(element => ({
        tag: element.tagName,
        placeholder: element.getAttribute('placeholder'),
        value: String(element.value || '').slice(0, 100)
      })).slice(0, 30),
      saveDisabled: Boolean(save.disabled || save.getAttribute('aria-disabled') === 'true')
      ,saveHtml: save.outerHTML.slice(0, 2000)
      ,saveReactProps: saveProps ? Object.keys(saveProps) : []
      ,directSaveError
      ,confirmationClicked
      ,requests: window.__fyowProbeRequests.slice(-20)
    };
  })()`, true);
  const capturedSave = (outcome.requests || []).find(request => /\/console\/api\/apps\/[^/]+\/model-config/.test(request.url));
  let saveResponse = null;
  if (capturedSave?.body) {
    const payload = JSON.parse(capturedSave.body);
    const probeEntry = Array.isArray(payload.world_book)
      ? payload.world_book.find(entry => String(entry?.key || "").includes(CREATOR_PROBE.worldBookKeyword))
      : null;
    if (!probeEntry) throw new Error("创作页没有组装出测试世界书条目");
    probeEntry.value = CREATOR_PROBE.worldBookContent;
    probeEntry.key_region = 2;
    await window.webContents.executeJavaScript("(() => { if (window.__fyowProbeOriginalFetch) window.fetch = window.__fyowProbeOriginalFetch; return true; })()", true);
    saveResponse = await authenticatedJson(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config`, {
      method: "POST",
      body: payload
    });
    if (!saveResponse.ok) throw new Error(`作品保存失败：HTTP ${saveResponse.status} ${saveResponse.payload?.message || saveResponse.payload?.msg || ""}`.trim());
  }
  await sleep(1200);
  const response = await authenticatedJson(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
  const root = unwrapPayload(response);
  const data = findObject(root, value => Object.hasOwn(value, "world_book") && (Object.hasOwn(value, "prpt") || Object.hasOwn(value, "pre_prompt"))) || root;
  const worldBookText = JSON.stringify(data?.world_book || []);
  const checks = {
    name: data?.name === CREATOR_PROBE.name,
    description: (data?.desc ?? data?.description) === CREATOR_PROBE.description,
    preText: (data?.pretxt ?? data?.pre_text) === CREATOR_PROBE.preText,
    postText: (data?.posttxt ?? data?.post_text) === CREATOR_PROBE.postText,
    prompt: (data?.prpt ?? data?.pre_prompt) === CREATOR_PROBE.prompt,
    worldBookKeyword: worldBookText.includes(CREATOR_PROBE.worldBookKeyword),
    worldBookContent: worldBookText.includes(CREATOR_PROBE.worldBookContent),
    userTrigger: /key[^]*2|user/i.test(worldBookText)
  };
  return {
    ui: {
      clicked: outcome.clicked,
      confirmationClicked: outcome.confirmationClicked,
      initialValidation: outcome.errorNotice || outcome.notice,
      userTrigger: outcome.userTrigger,
      capturedEndpoint: capturedSave?.url || null
    },
    save: saveResponse ? {
      ok: saveResponse.ok,
      status: saveResponse.status,
      code: saveResponse.payload?.code ?? null,
      result: saveResponse.payload?.result ?? saveResponse.payload?.message ?? null
    } : null,
    api: {
      ok: response.ok,
      status: response.status,
      code: response.payload?.code ?? null,
      worldBookCount: Array.isArray(data?.world_book) ? data.world_book.length : null,
      checks,
      worldBook: data?.world_book || null
    }
  };
}

async function main() {
  const accountA = requiredEnvironment("FYOW_TEST_ACCOUNT_A");
  const passwordA = requiredEnvironment("FYOW_TEST_PASSWORD_A");
  const isolatedSession = session.fromPartition(`fyow-live-${Date.now()}`, { cache: false });
  await isolatedSession.setProxy({ mode: "system" });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolatedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  try {
    const loginResult = await login(window, accountA, passwordA);
    if (MODE === "inspect") {
      const pages = [];
      for (const pathname of [
        "/zh/chats",
        "/zh/explore",
        "/zh/app/4ac2ab60-67ff-459d-ae9a-6274f1802195/configuration",
        "/zh/explore/installed/4ac2ab60-67ff-459d-ae9a-6274f1802195"
      ]) {
        try { pages.push(await inspectPage(window, pathname)); }
        catch (error) { pages.push({ pathname, error: error.message || String(error) }); }
      }
      process.stdout.write(`${JSON.stringify({ login: loginResult, pages }, null, 2)}\n`);
      return;
    }
    if (MODE === "discover-create") {
      await load(window, "/zh/app/4ac2ab60-67ff-459d-ae9a-6274f1802195/configuration");
      await clickExactText(window, "创作");
      process.stdout.write(`${JSON.stringify(await inspectCurrentPage(window), null, 2)}\n`);
      return;
    }
    if (MODE === "discover-advanced") {
      await load(window, "/zh/apps");
      await clickExactText(window, "高级创作");
      process.stdout.write(`${JSON.stringify(await inspectCurrentPage(window), null, 2)}\n`);
      return;
    }
    if (MODE === "inspect-config") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      const response = await authenticatedJson(window, `/go/api/apps/config?app_id=${encodeURIComponent(workId)}`);
      const data = response.payload?.data || response.payload;
      process.stdout.write(`${JSON.stringify({
        page: await inspectCurrentPage(window),
        api: {
          ok: response.ok,
          status: response.status,
          code: response.payload?.code,
          keys: data && typeof data === 'object' ? Object.keys(data) : [],
          appId: data?.app_id || data?.id || null,
          fieldTypes: Object.fromEntries(['pre_prompt','pre_text','post_text','world_book','description','name','model','conversation_id'].map(key => [key, Array.isArray(data?.[key]) ? `array:${data[key].length}` : typeof data?.[key]])),
          worldBook: Array.isArray(data?.world_book) ? data.world_book.slice(0, 3) : data?.world_book || null
        }
      }, null, 2)}\n`);
      return;
    }
    if (MODE === "inspect-config-api") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      const response = await authenticatedJson(window, `/go/api/apps/config?app_id=${encodeURIComponent(workId)}`);
      const data = response.payload?.data || response.payload;
      process.stdout.write(`${JSON.stringify({
        ok: response.ok,
        status: response.status,
        code: response.payload?.code,
        id: data?.id || null,
        conversationId: data?.conversation_id || null,
        fields: Object.fromEntries(['pre_prompt','pre_text','post_text','world_book','regex_replaces','model'].map(key => [key, data?.[key] ?? null]))
      }, null, 2)}\n`);
      return;
    }
    if (MODE === "inspect-creator-export") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      const response = await authenticatedJson(window, `/console/api/apps/${encodeURIComponent(workId)}/model-config/export`);
      const root = unwrapPayload(response);
      const data = findObject(root, value => Object.hasOwn(value, "world_book") && (Object.hasOwn(value, "pre_prompt") || Object.hasOwn(value, "pre_text"))) || root;
      process.stdout.write(`${JSON.stringify({
        ok:response.ok,
        status:response.status,
        keys:data && typeof data === 'object' ? Object.keys(data) : [],
        name:data?.name ?? data?.app?.name ?? null,
        description:data?.desc ?? data?.description ?? data?.app?.description ?? null,
        prePrompt:data?.prpt ?? data?.pre_prompt ?? null,
        preText:data?.pretxt ?? data?.pre_text ?? null,
        postText:data?.posttxt ?? data?.post_text ?? null,
        worldBook:data?.world_book ?? null
      }, null, 2)}\n`);
      return;
    }
    if (MODE === "inspect-worldbook") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      await clickExactText(window, "世界书设置");
      process.stdout.write(`${JSON.stringify(await inspectWorldBookEditor(window), null, 2)}\n`);
      return;
    }
    if (MODE === "discover-worldbook") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      await clickExactText(window, "世界书设置");
      await clickExactText(window, "+ 新增");
      process.stdout.write(`${JSON.stringify(await inspectWorldBookEditor(window), null, 2)}\n`);
      return;
    }
    if (MODE === "run-creator") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      const result = await configureAndSaveCreatorProbe(window, workId);
      process.stdout.write(`${JSON.stringify({ workId, result }, null, 2)}\n`);
      return;
    }
    if (MODE === "run-communications") {
      const workId = String(process.env.FYOW_TEST_COMM_WORK_ID || "4ac2ab60-67ff-459d-ae9a-6274f1802195");
      const result = await runCommunications(window, workId);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (MODE === "run-model") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      const sent = await runModelProbe(window, workId);
      const persisted = await inspectPersistedModelProbe(window, workId);
      process.stdout.write(`${JSON.stringify({ workId, sent, persisted }, null, 2)}\n`);
      return;
    }
    if (MODE === "inspect-model") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      const persisted = await inspectPersistedModelProbe(window, workId);
      process.stdout.write(`${JSON.stringify({ workId, persisted }, null, 2)}\n`);
      return;
    }
    if (MODE === "discover-client-schema") {
      const workId = requiredEnvironment("FYOW_TEST_WORK_ID");
      await load(window, `/zh/app/${encodeURIComponent(workId)}/configuration`);
      const result = await window.webContents.executeJavaScript(`(async () => {
        const urls = [...new Set([...document.scripts].map(script => script.src).filter(Boolean))];
        const hits = [];
        for (const url of urls) {
          const source = await fetch(url).then(response => response.text()).catch(() => '');
          for (const needle of ['value_region','key_region','world_book','worldBook']) {
            let from = 0;
            for (let count = 0; count < 8; count += 1) {
              const index = source.indexOf(needle, from);
              if (index < 0) break;
              hits.push({ url, needle, snippet:source.slice(Math.max(0, index - 800), index + 1800) });
              from = index + needle.length;
            }
          }
        }
        return { scriptCount:urls.length, hits };
      })()`, true);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (MODE === "discover-comments-client") {
      const workId = String(process.env.FYOW_TEST_COMM_WORK_ID || "4ac2ab60-67ff-459d-ae9a-6274f1802195");
      await load(window, `/zh/explore/installed/${encodeURIComponent(workId)}`);
      const result = await window.webContents.executeJavaScript(`(async () => {
        const urls = [...new Set([...document.scripts].map(script => script.src).filter(Boolean))];
        const hits = [];
        for (const url of urls) {
          const source = await fetch(url).then(response => response.text()).catch(() => '');
          for (const needle of ['/comments/','biz_type','parent_id','to_comment_id']) {
            let from = 0;
            for (let count = 0; count < 6; count += 1) {
              const index = source.indexOf(needle, from);
              if (index < 0) break;
              hits.push({ url, needle, snippet:source.slice(Math.max(0, index - 900), index + 1800) });
              from = index + needle.length;
            }
          }
        }
        return { scriptCount:urls.length, hits };
      })()`, true);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    throw new Error(`未知模式：${MODE}`);
  } finally {
    window.destroy();
    await isolatedSession.clearStorageData().catch(() => {});
  }
}

app.commandLine.appendSwitch("disable-gpu");
process.stdout.write("在线游戏世界平台联调启动\n");
app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => app.quit()).catch(error => {
  console.error(error.message || error);
  app.exit(1);
});
