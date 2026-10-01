// Real hidden WebContentsView + local HTTP/SSE integration. No account or model charges.
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const workspace = path.resolve(__dirname, '..');
const root = process.env.FYMP_QA_APP_ROOT || workspace;
const split = require(path.join(root, 'electron/perspective-split.cjs'));
const pipeline = require(path.join(root, 'electron/plugin-pipeline.cjs'));
const capture = require(path.join(root, 'electron/round-output-capture.cjs'));
const models = require(path.join(root, 'electron/auto-model-router.cjs'));
const { requestFreshModel, requestPlatformModel: requestConversationModel } = require(path.join(root, 'electron/fresh-model-request.cjs'));
const { normalizeModelPoints } = require(path.join(root, 'electron/model-stream.cjs'));
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const helpers = source.slice(source.indexOf('function platformPointBalance('), source.indexOf('async function mapConcurrent('));
const Backend = vm.runInNewContext(helpers + source.slice(source.indexOf('class AccountBackend'), source.indexOf('let mainWindow;')) + ';AccountBackend', {
  ...split, ...pipeline, ...capture, ...models, ...require(path.join(root, 'electron/multiplayer-prompts.cjs')),
  crypto, normalizeModelPoints, requestFreshModel, requestConversationModel, URL, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console
});
const outputDir = path.join(workspace, 'release-cache', 'perspective-pipeline-validation');
fs.mkdirSync(outputDir, { recursive: true });
app.setPath('userData', path.join(outputDir, 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QA exceeded 10 seconds')), 10000); })]); }
  finally { clearTimeout(timer); }
};
const sourceOutput = 'PUBLIC\nHOST PRIVATE\nGUEST PRIVATE';
const response = {
  protocol: split.PERSPECTIVE_SCHEMA,
  players: [{ player_key: 'a', display_name: 'Alice', body_segments: ['host'] }, { player_key: 'b', display_name: 'Bob', body_segments: ['guest'] }],
  segments: [
    { id: 'public', kind: 'other', audience: ['*'], text: 'PUBLIC\n' },
    { id: 'host', kind: 'body', audience: ['a'], text: 'HOST PRIVATE\n' },
    { id: 'guest', kind: 'body', audience: ['b'], text: 'GUEST PRIVATE' }
  ]
};
app.whenReady().then(async () => {
  let parent, view, server;
  const checks = [];
  const logs = [], modelCalls = [], broadcasts = [], projections = [];
  let mode = 'dynamic', requests = [];
  try {
    server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><body><script>
          window.bridgeAtLoad = Boolean(window.__fympHostFetchBridge);
          const cachedFetch = window.fetch.bind(window);
          const mode = ${JSON.stringify(mode)};
          setTimeout(() => {
            if (mode === 'missing-controls') return;
            document.body.innerHTML = '<textarea id="ai-chat-input"></textarea><button id="ai-send-button" disabled>Send</button>';
            const input = document.querySelector('textarea');
            const send = async () => {
              const options = { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({app_id:'story-work',conversation_id:'story-session',query:input.value}) };
              const result = mode === 'cached' ? await cachedFetch('/go/api/apps/chat-messages', options)
                : mode === 'request' || mode === 'fallback' ? await fetch(new Request(location.origin + '/go/api/apps/chat-messages', options))
                : await fetch('/go/api/apps/chat-messages', options);
              await result.text();
            };
            input.addEventListener('input', () => setTimeout(() => {
              const replacement = document.createElement('button'); replacement.id = 'ai-send-button'; replacement.onclick = send;
              document.querySelector('#ai-send-button').replaceWith(replacement);
            }, 30));
          }, 30);
        </script>`);
        return;
      }
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        const body = JSON.parse(text);
        requests.push({ path: req.url, body });
        if (mode === 'fallback' && req.url === '/go/api/apps/chat-messages') { res.writeHead(404); res.end(); return; }
        const isSplit = body.app_id === '0f357d8b-6170-4a22-afa7-72fef3490890';
        const answer = isSplit ? mode === 'split-invalid' ? 'invalid JSON' : JSON.stringify(response) : sourceOutput;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ event: 'message', answer, conversation_id: isSplit ? 'split-session' : 'story-session', message_id: isSplit ? 'split-message' : 'story-message' })}\n\ndata: {"event":"message_end","metadata":{"usage":{"input_points":2,"output_points":3}}}\n\n`);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = origin + '/zh/explore/installed/story-work';
    parent = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    parent.contentView.addChildView(view);
    view.setBounds({ x: -32000, y: -32000, width: 900, height: 700 });
    await view.webContents.loadURL(url);
    const backend = Object.assign(Object.create(Backend.prototype), {
      origin, work: { url }, workSettings: { saving: false }, conversation: { activeId: 'story-session' }, account: { accountId: 'a', points: 100 },
      gameSurface: view, platformSession: view.webContents.session, authSessionRevision: 1, networkReady: Promise.resolve(), pluginSettings: pipeline.normalizePluginSettings({ version: 2, plugins: { 'perspective-split': { enabled: true } } }),
      workGameUrl: () => url, isSameWorkPage: () => true, currentWorkAppId: () => 'story-work',
      emit() {}, assertToolLoggedIn() {}, recordAutomaticModelUsage() {}, detachSurface() {},
      appendSessionLog(category, detail) { logs.push({ category, ...detail }); },
      async loadSurfaceUrl(surface, target) {
        await surface.webContents.loadURL(target);
      },
      async ensureGameSurfaceMounted() {}, async applyGameIsolation() { return false; },
      async setPlatformConversationId() { await view.webContents.loadURL(url); },
      async syncHostMultiplayerConversationConfig() {}, async broadcastRoundState() {},
      async broadcastRoomPacket(type, payload) { broadcasts.push({ type, payload }); },
      async refreshConversations() {}, async advanceHostRoundAfterResultAcks() { return false; },
      async rememberPerspectiveView(raw, own) { projections.push({ raw, own }); },
      async refreshOnlineWorldPoints() { return this.account; },
      async ensureAnchor() { return { webContents: { isLoading: () => false, executeJavaScript: async () => '', session: view.webContents.session } }; },
      async withAutoModel(appId, label, execute, { reload } = {}) {
        modelCalls.push({ appId, label });
        await reload?.();
        return execute({ signal: new AbortController().signal, attempt: 1, model: { model: 'fixture-model', label: 'Fixture model' } });
      }
    });
    for (mode of ['direct-api', 'fallback', 'split-invalid', 'disabled']) {
      requests = []; logs.length = modelCalls.length = broadcasts.length = projections.length = 0;
      backend.pluginSettings.plugins['perspective-split'].enabled = mode !== 'disabled';
      backend.openLiveHostConversation = async () => false;
      backend.room = { role: 'host', save: { conversationId: 'story-session' }, members: [{ id: 'a', displayName: 'Alice' }, { id: 'b', displayName: 'Bob' }],
        round: { number: 1, status: 'collecting', submissions: { a: { text: 'host action' }, b: { text: 'guest action' } } } };
      await bounded(backend.maybeRunHostRound());
      assert.equal(backend.room.round.status, 'syncing', backend.room.round.error);
      const result = broadcasts.find(item => item.type === 'round-result')?.payload;
      assert.ok(result);
      const splitRequests = requests.filter(item => item.body.app_id === '0f357d8b-6170-4a22-afa7-72fef3490890');
      if (mode === 'disabled') {
        assert.equal(splitRequests.length, 0);
        assert.equal(result.output, sourceOutput);
      } else {
        assert.equal(splitRequests.length, mode === 'fallback' ? 2 : 1);
        assert.ok(splitRequests[0].body.query.includes(sourceOutput));
        assert.ok(splitRequests[0].body.query.includes('Alice') && splitRequests[0].body.query.includes('Bob'));
        assert.equal(splitRequests[0].body.conversation_id, undefined);
        assert.equal(modelCalls[1].appId, '0f357d8b-6170-4a22-afa7-72fef3490890');
        if (mode === 'fallback') assert.equal(splitRequests[1].path, '/console/api/installed-apps/0f357d8b-6170-4a22-afa7-72fef3490890/chat-messages');
        assert.equal(result.pluginRuns[0].appId, split.PERSPECTIVE_APP_ID);
        if (mode === 'split-invalid') {
          assert.equal(result.output, split.WITHHELD_OUTPUT);
          assert.equal(result.pluginRuns[0].status, 'error');
          assert.equal(split.personalizeResult(result, 'b').output, split.WITHHELD_OUTPUT);
        } else {
          assert.equal(result.output, 'PUBLIC\nHOST PRIVATE\n');
          assert.equal(result.pluginRuns[0].status, 'completed');
          assert.equal(split.personalizeResult(result, 'b').output, 'PUBLIC\nGUEST PRIVATE');
          assert.deepEqual(projections, [{ raw: sourceOutput, own: result.output }]);
          assert.ok(logs.some(item => item.category === 'perspective-split' && item.event === 'completed'));
        }
      }
      assert.ok(logs.some(item => item.category === 'round-flow' && item.event === 'request-dispatched'));
      assert.equal(await view.webContents.executeJavaScript('document.visibilityState'), 'hidden');
      checks.push({ mode, requests: requests.length, splitRequests: splitRequests.length, status: result.pluginRuns?.[0]?.status || 'disabled' });
    }
    mode = 'missing-controls'; requests = [];
    await view.webContents.loadURL(url);
    const controller = new AbortController();
    controller.abort();
    const pending = backend.sendModelInputAttempt('cancel before sending', controller.signal);
    pending.catch(() => {});
    await assert.rejects(bounded(pending), { name: 'AbortError' });
    assert.equal(requests.length, 0);
    checks.push({ mode: 'cancel-before-send', requests: 0 });
    await view.webContents.loadURL(url);
    await view.webContents.executeJavaScript(`(${capture.installHostOutputCapture.toString()})({appId:'story-work',input:'test',attemptId:'readiness'})`);
    await assert.rejects(bounded(view.webContents.executeJavaScript(`(${capture.sendHostModelInput.toString()})('test',{readyTimeoutMs:60})`)), /输入控件/);
    checks.push({ mode: 'missing-controls-stops-without-send', requests: 0 });
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ passed: true, version: require(path.join(root, 'package.json')).version, electron: process.versions.electron, checks }, null, 2));
    console.log('PERSPECTIVE PIPELINE QA PASSED: ' + checks.map(item => item.mode).join(', '));
  } catch (error) {
    console.error(error);
    const snapshot = await view?.webContents.executeJavaScript(`(() => {const c=window.__fympHostCapture;return {visibility:document.visibilityState,input:document.querySelector('textarea')?.value,button:document.querySelector('button')?.outerHTML,capture:c&&{requestSeen:c.requestSeen,accepted:c.accepted,error:c.error,events:c.events}}})()`).catch(() => null);
    fs.writeFileSync(path.join(outputDir, 'failure.json'), JSON.stringify({mode,logs,modelCalls,requests,snapshot},null,2));
    process.exitCode = 1;
  }
  finally { if (view && !view.webContents.isDestroyed()) view.webContents.close(); parent?.destroy(); server?.close(); app.exit(process.exitCode || 0); }
});
