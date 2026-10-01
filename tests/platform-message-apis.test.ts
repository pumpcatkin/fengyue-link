import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const operations = require('../electron/platform-message-operations.cjs');
const { preparePlatformTurn } = require('../electron/platform-turn-preparation.cjs');
const { requestFreshModel, requestPlatformModel } = require('../electron/fresh-model-request.cjs');
const { createConversationModelRequestPayload } = require('../electron/model-stream.cjs');
const router = require('../electron/auto-model-router.cjs');
const LF = String.fromCharCode(10);
const event = (data: any) => 'data: ' + JSON.stringify(data) + LF + LF;
const ids = { task_id: 't1', message_id: 'm1', conversation_id: 'c1' };
const complete = (answer = 'reply') => event({ event: 'message', answer, ...ids }) + event({ event: 'message_end', ...ids });
const base = { origin: 'https://example.invalid', workId: 'app', query: 'input', headers: { 'Content-Type': 'application/json' } };
const message = { id: 'm1', query: 'input', answer: 'old', created_at: 3, conversation_id: 'c1' };

describe('non-DOM generation and stop transport', () => {
  it('carries continuation and refresh fields only in the explicit conversation mode', async () => {
    expect(createConversationModelRequestPayload({ workId: 'app', query: 'q', conversationId: 'c1', messageId: 'm1', createdAt: 0, isRefresh: true })).toMatchObject({ conversation_id: 'c1', message_id: 'm1', created_at: 0, is_refresh: true });
    const fetch = vi.fn(async () => new Response(complete()));
    await requestFreshModel({ ...base, fetch, conversationId: 'wrong', messageId: 'wrong', isRefresh: true });
    const sent = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(sent).not.toHaveProperty('conversation_id');
    expect(sent).not.toHaveProperty('is_refresh');
  });
  it.each([404, 405])('falls back only after an absent generation route (%s)', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status })).mockResolvedValueOnce(new Response(complete()));
    await requestPlatformModel({ ...base, fetch, conversationId: 'c1', messageId: 'm1', isRefresh: true });
    expect(fetch.mock.calls[1]![0]).toBe('https://example.invalid/console/api/installed-apps/app/chat-messages');
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
  });
  it.each([401, 403, 429, 500, 502])('does not dispatch another generation after HTTP %s', async status => {
    const fetch = vi.fn(async () => Response.json({ message: 'failed' }, { status }));
    await expect(requestPlatformModel({ ...base, fetch })).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects an unexpected conversation before editing it', async () => {
    await expect(requestPlatformModel({ ...base, conversationId: 'other', fetch: async () => new Response(complete()) })).rejects.toThrow('其他会话');
  });
  it('preserves automatic model switching for explicit JSON business rejections', async () => {
    const fetch = vi.fn(async () => Response.json({ code: 12345, message: 'model unavailable' }));
    await expect(requestPlatformModel({ ...base, fetch })).rejects.toMatchObject({ retryable: true, requestRejected: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('accepts a stopped empty stream only after the server acknowledges stopping', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('chat-stop') ? Response.json({ code: 100000 }) : new Response(event({ event: 'message', ...ids, answer: '' })));
    await expect(requestPlatformModel({ ...base, fetch, stopAfterTask: true, allowEmpty: true })).resolves.toMatchObject({ answer: '', stopAcknowledged: true, finishEvent: 'server_stop', messageId: 'm1' });
    expect(fetch.mock.calls.filter(c => c[0].endsWith('chat-messages'))).toHaveLength(1);
  });
  it('uses the installed-app stop route when the Go stop route is absent', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('chat-stop')) return new Response('', { status: 404 });
      if (url.endsWith('/stop')) return Response.json({ code: 0 });
      return new Response(event({ event: 'message', ...ids }));
    });
    await expect(requestPlatformModel({ ...base, fetch, stopAfterTask: true, allowEmpty: true })).resolves.toMatchObject({ stopAcknowledged: true });
    expect(fetch.mock.calls[2]![0]).toBe('https://example.invalid/console/api/installed-apps/app/chat-messages/t1/stop');
  });
  it('does not treat a failed stop and EOF as successful completion', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('chat-stop') ? Response.json({ code: 1, message: 'denied' }, { status: 403 }) : new Response(event({ event: 'message', ...ids })));
    await expect(requestPlatformModel({ ...base, fetch, stopAfterTask: true, allowEmpty: true })).rejects.toThrow('完成标记');
  });
  it('keeps naturally completed empty placeholders valid without claiming a stop', async () => {
    const fetch = vi.fn(async () => new Response(event({ event: 'message_end', ...ids })));
    await expect(requestPlatformModel({ ...base, fetch, stopAfterTask: true, allowEmpty: true })).resolves.toMatchObject({ stopAcknowledged: false, finishEvent: 'message_end' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('pinned message mutations', () => {
  const params = { appId: 'app', conversationId: 'c1', id: 'm1', action: 'edit', answer: 'new' };
  it('edits raw long HTML through PATCH and verifies the exact ID', async () => {
    const answer = '<div>中文😀</div>'.repeat(10000);
    const api = vi.fn().mockResolvedValueOnce({ data: [message] }).mockResolvedValueOnce({}).mockResolvedValueOnce({ data: [{ ...message, answer }] });
    await expect(operations.mutatePlatformMessage(api, { ...params, answer }, { wait: vi.fn() })).resolves.toMatchObject({ verified: true });
    expect(api.mock.calls[1]).toEqual(['/installed-apps/app/messages/m1', { method: 'PATCH', body: { answer }, timeout: 15000, signal: undefined }]);
  });
  it('waits for deletion propagation without deleting another row', async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: [message] }).mockResolvedValueOnce({}).mockResolvedValueOnce({ data: [message] }).mockResolvedValueOnce({ data: [] });
    const wait = vi.fn();
    await expect(operations.mutatePlatformMessage(api, { ...params, action: 'delete' }, { wait })).resolves.toMatchObject({ verified: true });
    expect(wait).toHaveBeenCalledOnce();
    expect(api.mock.calls.filter(c => c[1]?.method === 'DELETE')).toHaveLength(1);
  });
  it('does not report deletion success for malformed server lists', async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: [message] }).mockResolvedValueOnce({}).mockResolvedValue({ data: { error: 'broken' } });
    await expect(operations.mutatePlatformMessage(api, { ...params, action: 'delete' }, { wait: vi.fn(), attempts: 2 })).rejects.toThrow('回读验证');
  });
  it('reconciles a lost PATCH response with a server read instead of writing twice', async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: [message] }).mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ data: [{ ...message, answer: 'new' }] });
    await expect(operations.mutatePlatformMessage(api, params)).resolves.toMatchObject({ verified: true });
    expect(api.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(1);
  });
  it('skips a repeated already-verified edit', async () => {
    const api = vi.fn(async () => ({ data: [{ ...message, answer: 'new' }] }));
    await expect(operations.mutatePlatformMessage(api, params)).resolves.toMatchObject({ reused: true });
    expect(api).toHaveBeenCalledOnce();
  });
  it('does not accept a matching answer from a different message', async () => {
    const api = vi.fn().mockResolvedValueOnce({ data: [message] }).mockResolvedValueOnce({}).mockResolvedValue({ data: [message, { ...message, id: 'other', answer: 'new' }] });
    await expect(operations.mutatePlatformMessage(api, params, { attempts: 1 })).rejects.toThrow('回读验证');
  });
  it('uses only recognized list wrappers', () => {
    expect(operations.readMessageRecords({ data: { messages: [message] } }, { strict: true })).toEqual([message]);
    expect(() => operations.readMessageRecords({ diagnostics: [] }, { strict: true })).toThrow();
    expect(() => operations.readMessageRecords({ data: [{ foo: 'bar' }] }, { strict: true })).toThrow();
  });
});

describe('guest preparation is one request per round', () => {
  function fixture() {
    const state: any = {}; let saved = false;
    const requestModel = vi.fn(async () => { saved = true; return { conversationId: 'c1', messageId: 'new', stopAcknowledged: true }; });
    const readRecords = vi.fn(async () => saved ? [{ ...message, id: 'new', answer: '' }, message] : [message]);
    return { state, requestModel, readRecords, appId: 'app', conversationId: 'c1', query: 'input', wait: vi.fn() };
  }
  it('creates a new placeholder when an older round has identical input', async () => {
    const f = fixture();
    await expect(preparePlatformTurn(f)).resolves.toMatchObject({ messageId: 'new' });
    await preparePlatformTurn(f);
    expect(f.requestModel).toHaveBeenCalledOnce();
  });
  it('retains dispatch state after an unknown network failure and does not resend', async () => {
    const f = fixture();
    f.requestModel = vi.fn(async () => { throw new Error('reset after acceptance'); });
    await expect(preparePlatformTurn(f)).rejects.toThrow('reset');
    await expect(preparePlatformTurn(f)).rejects.toThrow('暂停重复生成');
    expect(f.requestModel).toHaveBeenCalledOnce();
  });
  it('rechecks an already-completed record after a transient read failure', async () => {
    const f = fixture(); let reads = 0;
    f.readRecords = vi.fn(async () => { if (++reads === 2) throw new Error('temporary'); return reads === 1 ? [] : [{ ...message, id: 'new' }]; });
    await expect(preparePlatformTurn(f)).rejects.toThrow('temporary');
    await expect(preparePlatformTurn(f)).resolves.toMatchObject({ messageId: 'new' });
    expect(f.requestModel).toHaveBeenCalledOnce();
  });
  it('permits retry only after an explicit pre-acceptance rejection', async () => {
    const f = fixture();
    f.requestModel = vi.fn().mockRejectedValueOnce(Object.assign(new Error('rate limit'), { requestRejected: true }));
    await expect(preparePlatformTurn(f)).rejects.toThrow('rate limit');
    expect(f.state.sent).toBe(false);
  });
  it('does not send or overwrite another input under the same round key', async () => {
    const f = fixture(); f.state.input = 'previous';
    await expect(preparePlatformTurn(f)).rejects.toThrow('输入发生变化');
    expect(f.requestModel).not.toHaveBeenCalled();
  });
});

function backend() {
  const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const Type = vm.runInNewContext(source.slice(source.indexOf('class AccountBackend'), source.indexOf('let mainWindow;')) + '; AccountBackend', {
    ...operations, ...router, preparePlatformTurn, URL, AbortController, setTimeout: (fn: any) => setTimeout(fn, 0), clearTimeout, console
  });
  return Object.assign(Object.create(Type.prototype), { work: { url: 'https://example.invalid/work' }, room: { id: 'room', save: { conversationId: 'c1' } },
    conversation: { activeId: 'c1', items: [] }, authSessionRevision: 1, origin: base.origin, currentWorkAppId: () => 'app',
    appendSessionLog: vi.fn(), setPlatformConversationId: vi.fn(async () => true), applyGameIsolation: vi.fn(async () => true) });
}
describe('backend API integration', () => {
  it('uses the observed Go detail endpoint only on a missing list route', async () => {
    const b = backend();
    b.readPlatformMessages = vi.fn(async () => { throw Object.assign(new Error('missing route'), { status: 404 }); });
    b.platformGoApi = vi.fn(async () => ({ message }));
    await expect(b.readPlatformMessage('app', 'c1', 'm1', 3)).resolves.toEqual(message);
    expect(b.platformGoApi.mock.calls[0]).toEqual(['/apps/message', { method: 'POST', body: { message_id: 'm1', message_created_at: 3 }, signal: undefined }]);
  });
  it('does not use another route for forbidden or rate-limited reads', async () => {
    const b = backend(); b.platformGoApi = vi.fn();
    b.readPlatformMessages = async () => { throw Object.assign(new Error('limited'), { status: 429 }); };
    await expect(b.readPlatformMessage('app', 'c1', 'm1', 3)).rejects.toThrow('limited');
    expect(b.platformGoApi).not.toHaveBeenCalled();
  });
  it('does not interpret an empty detail response as confirmed deletion', async () => {
    const b = backend(); b.readPlatformMessages = async () => { throw Object.assign(new Error('route'), { status: 404 }); };
    b.platformGoApi = async () => ({ data: {} });
    await expect(b.readPlatformMessage('app', 'c1', 'm1', 3)).rejects.toThrow('未返回匹配记录');
  });
  it('synchronizes a prepared guest message entirely through detail fallback when the list route is absent', async () => {
    const b = backend(); let answer = '';
    b.guestPreparedTurns = new Map([['room:1', { appId: 'app', revision: 1, conversationId: 'c1', messageId: 'm1', createdAt: 3, ended: true }]]);
    b.readPlatformMessages = async () => { throw Object.assign(new Error('route'), { status: 404 }); };
    b.platformGoApi = async () => ({ data: { message: { ...message, query: undefined, origin_query: 'input', answer } } });
    b.platformChatApi = vi.fn(async (_: string, options: any) => { expect(options.method).toBe('PATCH'); answer = options.body.answer; return {}; });
    b.refreshConversations = async () => ({ ...b.conversation });
    await expect(b.syncGuestRoundResult({ round: 1, input: 'input', output: 'host output' })).resolves.toMatchObject({ gameReady: true });
    expect(answer).toBe('host output');
    expect(b.platformChatApi).toHaveBeenCalledOnce();
  });
  it('pins a repeated delete to its original message', async () => {
    const b = backend(); let records = [message, { ...message, id: 'older', created_at: 1 }];
    b.readPlatformMessages = async () => records;
    b.platformChatApi = vi.fn(async (_: string, options: any) => { if (options.method === 'DELETE') records = records.filter(r => r.id !== 'm1'); return {}; });
    await b.performLatestPlatformMessageAttempt('delete', '', { operationKey: 'one-operation' });
    await b.performLatestPlatformMessageAttempt('delete', '', { operationKey: 'one-operation' });
    expect(b.platformChatApi).toHaveBeenCalledOnce();
    expect(records[0]!.id).toBe('older');
  });
  it('waits past a stale refresh read with the same message ID', async () => {
    const b = backend(); let reads = 0;
    b.readPlatformMessages = async () => [{ ...message, answer: ++reads >= 3 ? 'refreshed' : 'old' }];
    b.requestPlatformModel = vi.fn(async () => ({ answer: 'refreshed', messageId: 'm1', conversationId: 'c1' }));
    const controller = new AbortController();
    await expect(b.performLatestPlatformMessageAttempt('refresh', '', { signal: controller.signal })).resolves.toMatchObject({ output: 'refreshed' });
    expect(reads).toBe(3);
    expect(b.requestPlatformModel.mock.calls[0][0]).toMatchObject({ conversationId: 'c1', messageId: 'm1', isRefresh: true, createdAt: 3, signal: controller.signal });
  });
  it('never sends a model request to repair a missing guest result record', async () => {
    const b = backend(); b.readPlatformMessages = async () => []; b.requestPlatformModel = vi.fn();
    await expect(b.syncGuestRoundResult({ round: 1, input: 'input', output: 'host' })).rejects.toThrow('只编辑已有记录');
    expect(b.requestPlatformModel).not.toHaveBeenCalled();
  });
});
