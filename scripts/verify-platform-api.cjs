// Real Electron session + local HTTP/SSE. No production mutations or paid calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const workspace = path.resolve(__dirname, '..');
const root = process.env.FYMP_QA_APP_ROOT || workspace;
const output = path.join(workspace, 'release-cache', 'platform-api-validation');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
const transport = require(path.join(root, 'electron/platform-transport.cjs'));
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const Backend = vm.runInNewContext(source.slice(source.indexOf('class AccountBackend'), source.indexOf('let mainWindow;')) + ';AccountBackend', {
  ...transport, ...require(path.join(root, 'electron/platform-message-operations.cjs')), ...require(path.join(root, 'electron/platform-turn-preparation.cjs')),
  ...require(path.join(root, 'electron/auto-model-router.cjs')), requestConversationModel: require(path.join(root, 'electron/fresh-model-request.cjs')).requestPlatformModel,
  URL, AbortController, crypto, setTimeout, clearTimeout, setInterval, clearInterval, console
});
const LF = String.fromCharCode(10);
const sse = value => 'data: ' + JSON.stringify(value) + LF + LF;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
app.whenReady().then(async () => {
  let server, view; const checks = [], calls = [], tasks = new Map();
  const watchdog = setTimeout(() => { console.error('API QA timed out'); app.exit(1); }, 90000);
  let counter = 1, generationCount = 0, failGo = false, missingList = false, legacy = false;
  let records = [{ id: 'older', query: 'old input', answer: 'old answer', created_at: 1, conversation_id: 'c1' }];
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      calls.push({ method: req.method, path: url.pathname });
      if (url.pathname === '/view') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><body><aside>Website navigation</aside><main class="chat-container"><section>' + records.map(r =>
          '<div id="customized-question" class="changed-question-class"><span id="customized-question-content">' + escape(r.query) + '</span></div>' +
          '<div id="' + (legacy ? 'ai-chat-answer' : 'customized-answer') + '" class="changed-answer-class"><div id="customized-answer-container"><div id="customized-answer-content">' + escape(r.answer) +
          '</div><div id="customized-message-answer-actions"><button onclick="window.buttonClicked=true">Edit</button></div></div></div>').join('') + '</section></main></body>');
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/messages')) return json({ data: records.slice().reverse() }, missingList ? 404 : 200);
      let text = ''; req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(text || '{}'); } catch {}
        if (url.pathname === '/go/api/apps/message') return json({ code: 100000, data: { message: records.find(r => r.id === body.message_id) } });
        if (req.method === 'PATCH') { const r = records.find(r => url.pathname.endsWith('/' + r.id)); if (!r) return json({}, 404); r.answer = body.answer; return json({}); }
        if (req.method === 'DELETE') { records = records.filter(r => !url.pathname.endsWith('/' + r.id)); return json({}); }
        if (url.pathname.endsWith('chat-stop') || url.pathname.endsWith('/stop')) {
          const task = tasks.get(body.task_id || url.pathname.split('/').at(-2));
          if (task) { clearTimeout(task.timer); task.finish(''); tasks.delete(task.id); }
          return json({ code: 100000 });
        }
        if (url.pathname.endsWith('chat-messages')) {
          if (failGo && url.pathname.startsWith('/go/')) return json({}, 404);
          generationCount++;
          let record = body.is_refresh ? records.find(r => r.id === body.message_id) : null;
          if (!record) { record = { id: 'm' + ++counter, query: body.query, answer: '', created_at: counter, conversation_id: body.conversation_id || 'c1' }; records.push(record); }
          const taskId = 't' + counter;
          const ids = { task_id: taskId, message_id: record.id, conversation_id: record.conversation_id };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sse({ event: 'message', answer: '', ...ids }));
          const finish = answer => { record.answer = answer; res.end(sse({ event: 'message', answer, ...ids }) + sse({ event: 'message_end', ...ids })); };
          tasks.set(taskId, { id: taskId, finish, timer: setTimeout(() => { tasks.delete(taskId); finish('REFRESHED'); }, 150) });
          return;
        }
        json({ message: 'unknown fixture route' }, 404);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    view = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await view.loadURL(origin + '/view');
    const backend = Object.assign(Object.create(Backend.prototype), {
      origin, authSessionRevision: 1, networkReady: Promise.resolve(), platformSession: view.webContents.session, anchor: view, gameSurface: view,
      work: { url: origin + '/view', suffix: 'work' }, room: { id: 'room', role: 'guest', save: { key: 'save', name: 'Fixture', conversationId: 'c1' } },
      conversation: { activeId: 'c1', activeName: 'Fixture', items: [] }, currentWorkAppId: () => 'work', liveGameSurface: true,
      gamePrivacyCssPromise: Promise.resolve(), keepGameSurfaceResident() {}, emit() {}, persistSaveAnchor() {}, appendSessionLog() {},
      async captureGameFrame() {}, async refreshConversations() { return { ...this.conversation }; },
      async setPlatformConversationId(id) { assert.equal(id, 'c1'); await view.loadURL(origin + '/view'); }
    });
    const [first, second] = await Promise.all([backend.prepareGuestRoundInput({ round: 1, input: 'round input' }), backend.prepareGuestRoundInput({ round: 1, input: 'round input' })]);
    assert.equal(first.messageId, second.messageId); assert.equal(generationCount, 1);
    assert.equal(first.terminationMode, 'server-stop-confirmed');
    checks.push('concurrent guest preparation sends once and receives stop acknowledgement');
    const answer = '<article>同步😀</article>'.repeat(1800);
    const synced = await backend.syncGuestRoundResult({ round: 1, input: 'round input', output: answer });
    assert.equal(records.at(-1).answer, answer); assert.equal(synced.gameReady, true);
    const displayed = await view.webContents.executeJavaScript(`({text:document.querySelectorAll('#customized-answer-content')[1].textContent,clicked:!!window.buttonClicked,actions:getComputedStyle(document.querySelector('#customized-message-answer-actions')).display})`);
    assert.equal(displayed.text, answer); assert.equal(displayed.clicked, false); assert.equal(displayed.actions, 'none');
    checks.push('guest PATCH and new DOM display match full host output with no button click');
    await backend.performLatestPlatformMessageAttempt('edit', 'EDITED');
    assert.equal(records.at(-1).answer, 'EDITED');
    failGo = true;
    const refreshed = await backend.performLatestPlatformMessageAttempt('refresh');
    assert.equal(refreshed.output, 'REFRESHED'); assert.equal(generationCount, 2);
    assert.ok(calls.some(c => c.path === '/console/api/installed-apps/work/chat-messages'));
    checks.push('edit and refresh use exact IDs and confirmed standby generation route');
    missingList = true;
    const detail = await backend.readPlatformMessage('work', 'c1', first.messageId, records.at(-1).created_at);
    assert.equal(detail.answer, 'REFRESHED'); missingList = false;
    checks.push('message-detail standby verifies a known ID');
    await backend.performLatestPlatformMessageAttempt('delete', '', { operationKey: 'delete-1' });
    await backend.performLatestPlatformMessageAttempt('delete', '', { operationKey: 'delete-1' });
    assert.equal(records.length, 1); assert.equal(records[0].id, 'older');
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
    checks.push('repeated delete does not target the previous message');
    legacy = true; await view.loadURL(origin + '/view');
    assert.equal(await backend.applyGameIsolation(true), true);
    checks.push('legacy semantic answer ID remains readable');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, version: require(path.join(root, 'package.json')).version, electron: process.versions.electron, checks }, null, 2));
    console.log('PLATFORM API QA PASSED: ' + checks.join('; '));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(watchdog); for (const task of tasks.values()) clearTimeout(task.timer); view?.destroy(); server?.close(); app.exit(process.exitCode || 0); }
});
