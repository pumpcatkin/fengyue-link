import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { installHostOutputCapture } = require('../electron/round-output-capture.cjs');
function setup(response: Response) {
  const fetch = vi.fn(async (_resource: any, _options?: any) => response);
  const window: any = { fetch };
  const context = vm.createContext({ window, URL, location: { href: 'https://example.org/game', origin: 'https://example.org' },
    TextDecoder, Uint8Array, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vm.runInContext(`(${installHostOutputCapture.toString()})({appId:'work',input:'question',attemptId:'attempt'})`, context);
  const send = () => window.fetch('/go/api/apps/chat-messages', { body: JSON.stringify({ app_id: 'work', query: 'question' }) });
  return { window, send, fetch };
}
describe('request-bound round capture without generation deadlines', () => {
  it('delivers completed text without DOM or billing fields', async () => {
    const { window, send } = setup(new Response('data: {"event":"message","answer":"正文","conversation_id":"c1","message_id":"m1"}\n\ndata: {"event":"message_end"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await send();
    await expect(window.__fympHostCapture.promise).resolves.toMatchObject({ output: '正文', conversationId: 'c1', messageId: 'm1' });
  });
  it('does not auto-retry an ambiguous disconnected stream', async () => {
    const { window, send } = setup(new Response('data: {"event":"message","answer":"半截","conversation_id":"c1","message_id":"m1"}\n\n'));
    await send();
    await expect(window.__fympHostCapture.promise).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED', retryable: false });
  });
  it('falls back to the installed-app endpoint only when the route is absent', async () => {
    const { window, send, fetch } = setup(new Response('', { status: 404 }));
    fetch.mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json({ answer: 'fallback', conversation_id: 'c', message_id: 'm' }));
    await send();
    await expect(window.__fympHostCapture.promise).resolves.toMatchObject({ output: 'fallback' });
    expect(fetch.mock.calls[1]?.[0]).toBe('/console/api/installed-apps/work/chat-messages');
  });
  it('does not fallback or auto-retry payment and authentication failures', async () => {
    const { window, send, fetch } = setup(Response.json({ message: 'payment required' }, { status: 402 }));
    await send();
    await expect(window.__fympHostCapture.promise).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects a second send while the original stream is pending', async () => {
    let controller: any;
    const { window, send, fetch } = setup(new Response(new ReadableStream({ start(c) { controller = c; } })));
    await send();
    await expect(send()).rejects.toThrow('已发送');
    expect(fetch).toHaveBeenCalledOnce();
    controller.close();
    await expect(window.__fympHostCapture.promise).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED' });
  });
  it('keeps a long live stream pending until an explicit end', async () => {
    let controller: any;
    const { window, send } = setup(new Response(new ReadableStream({ start(c) { controller = c; } })));
    await send();
    let ended = false; window.__fympHostCapture.promise.then(() => ended = true);
    controller.enqueue(new TextEncoder().encode('data: {"event":"message","answer":"继续","conversation_id":"c","message_id":"m"}\n\n'));
    await new Promise(resolve => setImmediate(resolve));
    expect(ended).toBe(false);
    controller.enqueue(new TextEncoder().encode('data: {"event":"message_end"}\n\n')); controller.close();
    await expect(window.__fympHostCapture.promise).resolves.toMatchObject({ output: '继续' });
  });
});
