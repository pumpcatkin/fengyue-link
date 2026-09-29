import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
const require = createRequire(import.meta.url);
const router = require('../electron/auto-model-router.cjs');
const { requestFreshModel } = require('../electron/fresh-model-request.cjs');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const body = (value: any) => `data: ${JSON.stringify(value)}\n\n`;
const message = { event: 'message', answer: 'raw result', task_id: 'task', conversation_id: 'conversation', message_id: 'message' };
function options(fetch: any, controller = new AbortController()) {
  return { fetch, origin: 'https://example.invalid', workId: 'adapter', query: 'sample', headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
}
function backend() {
  const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const Backend = vm.runInNewContext(`${source.slice(source.indexOf('class AccountBackend'), source.indexOf('let mainWindow;'))}; AccountBackend`, {
    ...router, AbortController, setInterval, clearInterval, setTimeout, clearTimeout, crypto: require('node:crypto'),
    PREFIX_ADAPTER_APP_ID: 'adapter'
  });
  return Object.assign(Object.create(Backend.prototype), {
    assertToolLoggedIn: vi.fn(), loggedIn: true, authSessionRevision: 1, work: { suffix: 'work' }, room: null,
    appendSessionLog: vi.fn(), emit: vi.fn(), autoModelJobs: new Map(), autoModelQueues: new Map(),
    currentWorkAppId: () => 'work',
    platformGoApi: async () => ({ models: [{ provider_name: 'p', model_id: 'model' }] }), configureAutomaticModel: vi.fn()
  });
}
describe('prefix adapter stream transport', () => {
  it('uses a fresh conversation and raw stream text without DOM or billing labels', async () => {
    const fetch = vi.fn(async () => new Response(body(message) + body({ event: 'message_end' })));
    const result = await requestFreshModel(options(fetch));
    expect(result).toMatchObject({ answer: 'raw result', conversationId: 'conversation', messageId: 'message', points: null });
    const sent = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(sent).toMatchObject({ response_mode: 'streaming', app_id: 'adapter', query: 'sample' });
    expect(sent).not.toHaveProperty('conversation_id');
  });
  it('falls back only when the route is absent', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? new Response('', { status: 404 }) : new Response(body(message) + body({ event: 'message_end' }));
    });
    await requestFreshModel(options(fetch));
    expect(calls[1]).toContain('/console/api/installed-apps/adapter/chat-messages');
  });
  it('does not automatically retry a stream whose acceptance is uncertain', async () => {
    await expect(requestFreshModel(options(async () => new Response(body(message))))).rejects.toMatchObject({ retryable: false });
  });
  it('cancels while waiting for response headers even if the fetch implementation never settles', async () => {
    const controller = new AbortController(), fetch = vi.fn(() => new Promise(() => {}));
    const pending = requestFreshModel(options(fetch, controller));
    await tick(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('cancels an open stream and sends the known task to the stop endpoint', async () => {
    const controller = new AbortController(), calls: string[] = [];
    let stream!: ReadableStreamDefaultController;
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('chat-stop')) return Response.json({ code: 100000 });
      return new Response(new ReadableStream({ start(c) { stream = c; } }));
    });
    const pending = requestFreshModel(options(fetch, controller));
    await tick(); stream.enqueue(new TextEncoder().encode(body(message)));
    await tick(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(calls).toEqual(['https://example.invalid/go/api/apps/chat-messages', 'https://example.invalid/go/api/apps/chat-stop']);
  });
  it('does not mistake long silence for failure or trigger another request', async () => {
    vi.useFakeTimers();
    try {
      let stream!: ReadableStreamDefaultController;
      const fetch = vi.fn(async () => new Response(new ReadableStream({ start(c) { stream = c; } })));
      const pending = requestFreshModel(options(fetch)); let settled = false;
      pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(settled).toBe(false); expect(fetch).toHaveBeenCalledOnce();
      stream.enqueue(new TextEncoder().encode(body(message) + body({ event: 'message_end' }))); stream.close();
      await expect(pending).resolves.toMatchObject({ answer: 'raw result' });
    } finally { vi.useRealTimers(); }
  });
});
describe('cancellation across preparation and queued requests', () => {
  it('cancels collecting samples and rejects late results without replacing the old adapter', async () => {
    const b = backend();
    let finish!: (value: any) => void;
    b.collectPrefixAdapterSamples = () => new Promise(resolve => { finish = resolve; });
    b.runPrefixAdapterModel = vi.fn();
    const previous = { adapters: { work: { fragment: 'keep' } } }; b.prefixAdapters = previous;
    const pending = b.adaptCurrentWorkPrefix();
    await tick(); b.cancelAutoModels(null, { jobId: 'prefix-adapter' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finish([]); await tick();
    expect(b.prefixAdapterBusy).toBe(false);
    expect(b.prefixAdapterOperation.stage).toBe('cancelled');
    expect(b.runPrefixAdapterModel).not.toHaveBeenCalled();
    expect(b.prefixAdapters).toBe(previous);
  });
  it('cancels during model configuration and never starts late generation', async () => {
    const b = backend(); let configured!: () => void;
    b.configureAutomaticModel = () => new Promise<void>(resolve => { configured = resolve; });
    const execute = vi.fn();
    const pending = b.withAutoModel('app', 'operation', execute);
    await tick();
    const id = [...b.autoModelJobs.keys()][0];
    b.cancelAutoModels(null, { jobId: id });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    configured(); await tick();
    expect(execute).not.toHaveBeenCalled();
    expect(b.autoModelJobs.size).toBe(0);
  });
  it('cancels queued work immediately without letting later work bypass the active request', async () => {
    const b = backend();
    const first = b.withAutoModel('app', 'first', () => new Promise(() => {}));
    await tick();
    const secondWork = vi.fn(), thirdWork = vi.fn(async () => 'third');
    const second = b.withAutoModel('app', 'second', secondWork);
    await tick();
    const jobs: any[] = [...b.autoModelJobs.values()];
    b.cancelAutoModels(null, { jobId: jobs.find(j => j.state.label === 'second').state.id });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const third = b.withAutoModel('app', 'third', thirdWork);
    await tick(); expect(thirdWork).not.toHaveBeenCalled();
    b.cancelAutoModels(null, { jobId: jobs.find(j => j.state.label === 'first').state.id });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(third).resolves.toBe('third');
    expect(secondWork).not.toHaveBeenCalled();
    expect(b.autoModelJobs.size).toBe(0);
  });
  it('cancels only the selected task and its owning editor controller', () => {
    const b = backend(), editor = new AbortController(), platform = new AbortController();
    b.editorHarnessController = new AbortController();
    b.autoModelJobs.set('editor', { scope: 'online-world-editor', state: { id: 'editor' }, controller: editor });
    b.autoModelJobs.set('platform', { scope: 'platform', state: { id: 'platform' }, controller: platform });
    b.cancelAutoModels(null, { jobId: 'editor' });
    expect(editor.signal.aborted).toBe(true);
    expect(b.editorHarnessController.signal.aborted).toBe(true);
    expect(platform.signal.aborted).toBe(false);
  });
});
