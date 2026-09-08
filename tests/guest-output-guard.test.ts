import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { installGuestOutputGuard } = require('../electron/guest-output-guard.cjs');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture({ failures = 0, closeOnStop = true, acknowledged = true } = {}) {
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
  let attempts = 0;
  const send = (value: unknown) => stream.enqueue(new TextEncoder().encode(typeof value === 'string' ? value : `data: ${JSON.stringify(value)}\n\n`));
  const nativeFetch = vi.fn(async (resource: string, options: any) => {
    if (resource === '/go/api/apps/chat-stop') {
      expect(JSON.parse(options.body)).toEqual({ task_id: 'task-current' });
      attempts++;
      if (attempts <= failures || !acknowledged) return Response.json({ code: 100400, msg: 'not registered yet' });
      if (closeOnStop) { send({ event: 'message_end' }); stream.close(); }
      return Response.json({ code: 100000, msg: 'ok' });
    }
    if (!String(resource).includes('/chat-messages')) return Response.json({ ok: true });
    return response;
  });
  const window: any = { fetch: nativeFetch, actualResponseMode: 'blocking' };
  const install = vm.runInNewContext(`(${installGuestOutputGuard.toString()})`, {
    window, location: new URL('https://example.invalid/work'), URL, Headers, TextDecoder, AbortController,
    localStorage: { getItem: () => 'test-token' },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 10)), clearTimeout
  });
  const config = { appId: 'app', syncKey: 'room:1', input: 'expected', conversationId: 'conversation' };
  install(config);
  const start = () => window.fetch('https://example.invalid/go/api/apps/chat-messages', { method: 'POST', body: JSON.stringify({ app_id: 'app', query: 'expected', conversation_id: 'conversation', response_mode: 'streaming' }) });
  const state = () => window.__fympGuestOutputGuard.states['room:1'];
  const finish = async () => { for (let n = 0; n < 150 && !state().finishedAt; n++) await sleep(5); expect(state().finishedAt).toBeTruthy(); return state(); };
  return { window, send, start, state, finish, stream: () => stream, nativeFetch, install, config };
}

describe('guest generation task termination', () => {
  it('waits for a real task id instead of assuming an early UI stop succeeded', async () => {
    const f = fixture();
    await f.start();
    f.send(':heartbeat\n\n');
    await sleep(20);
    expect(f.state().ready).toBe(false);
    expect(f.nativeFetch).toHaveBeenCalledTimes(1);
    f.send({ event: 'message', task_id: 'task-current', message_id: 'message-current', conversation_id: 'conversation', answer: '' });
    expect(await f.finish()).toMatchObject({ ready: true, stopAcknowledged: true, streamEnded: true, messageId: 'message-current', outputCharacters: 0 });
    expect(f.window.actualResponseMode).toBe('blocking');
  });
  it('parses task ids across stream chunks and retries rejected stop acknowledgements', async () => {
    const f = fixture({ failures: 1 });
    await f.start();
    f.send('data: {"event":"message","task_');
    f.send('id":"task-current","message_id":"m"}\n\n');
    expect(await f.finish()).toMatchObject({ ready: true, stopAttempts: 2, stopAcknowledged: true });
  });
  it('does not allow editing while the stream continues after the stop response', async () => {
    const f = fixture({ closeOnStop: false });
    await f.start();
    f.send({ event: 'message', task_id: 'task-current' });
    await sleep(20);
    expect(f.state().stopAcknowledged).toBe(true);
    expect(f.state().ready).toBe(false);
    f.send({ event: 'message', answer: 'late chunk' });
    f.send({ event: 'message_end' });f.stream().close();
    expect(await f.finish()).toMatchObject({ ready: true, outputCharacters: 10 });
  });
  it('does not treat HTTP 200 with an error code as a successful stop', async () => {
    const f = fixture({ acknowledged: false });
    await f.start();f.send({ event: 'message', task_id: 'task-current' });f.stream().close();
    expect(await f.finish()).toMatchObject({ ready: false, stopAcknowledged: false, stopAttempts: 4 });
  });
  it('blocks a duplicate send while preserving unrelated platform requests', async () => {
    const f = fixture();await f.start();
    f.install(f.config);
    await expect(f.start()).rejects.toThrow('重复生成');
    await f.window.fetch('/go/api/apps/config', {});
    expect(f.nativeFetch).toHaveBeenCalledTimes(2);
    f.send({ event: 'message', task_id: 'task-current' });await f.finish();
  });
  it('stops input transformed by work filters but leaves other conversations alone', async () => {
    const f = fixture();
    await f.window.fetch('/go/api/apps/chat-messages', { body: JSON.stringify({ app_id: 'app', conversation_id: 'another', query: 'expected' }) });
    expect(f.state().requestSeen).toBe(false);
    await f.window.fetch('/go/api/apps/chat-messages', { body: JSON.stringify({ app_id: 'app', conversation_id: 'conversation', query: 'filtered input' }) });
    f.send({ event: 'message', task_id: 'task-current' });
    expect(await f.finish()).toMatchObject({ ready: true, inputTransformed: true });
  });
  it('releases a finished guard and does not re-arm it when inspecting the same round', async () => {
    const f = fixture();await f.start();
    f.send({ event: 'message', task_id: 'task-current' });await f.finish();
    expect(f.window.__fympGuestOutputGuard.active).toBeNull();
    f.install(f.config);
    await expect(f.start()).resolves.toBeInstanceOf(Response);
    expect(f.window.__fympGuestOutputGuard.active).toBeNull();
    expect(f.window.actualResponseMode).toBe('blocking');
  });
  it('fails closed when the response connection drops without a confirmed end', async () => {
    const f = fixture();await f.start();f.stream().error(new Error('connection dropped'));
    expect(await f.finish()).toMatchObject({ ready: false, streamError: 'connection dropped' });
  });
  it('recognizes normal completion separately and rejects platform error events', async () => {
    const f = fixture();await f.start();f.send({ event: 'message', answer: 'complete' });f.send({ event: 'message_end' });f.stream().close();
    expect(await f.finish()).toMatchObject({ ready: true, stopAcknowledged: false, terminalEvent: true });
    const failed = fixture();await failed.start();failed.send({ event: 'error', message: '系统繁忙' });failed.stream().close();
    expect(await failed.finish()).toMatchObject({ ready: false, error: '系统繁忙' });
  });
});
