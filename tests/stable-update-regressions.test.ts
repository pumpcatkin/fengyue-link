import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi, afterEach } from 'vitest';
const require = createRequire(import.meta.url);
const editor = require('../electron/online-game-editor.cjs');
const cards = require('../electron/online-world-card.cjs');
const harness = require('../electron/game-harness.cjs');
const knowledge = require('../electron/harness-knowledge.cjs');
const { OnlineWorldService } = require('../electron/online-world-service.cjs');
const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../electron/desktop/renderer.js', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function backend(extra: any = {}) {
  const Backend = vm.runInNewContext(`${main.slice(main.indexOf('class AccountBackend'), main.indexOf('let mainWindow;'))}; AccountBackend`, {
    ...editor, summarizeGameCard: cards.summarizeGameCard,
    harnessFingerprint: harness.fingerprint, harnessFiles: harness.projectFiles,
    isStandalone: require('../electron/standalone-game.cjs').isStandalone,
    PERSPECTIVE_PLUGIN_ID: 'perspective', PLUGIN_PHASES: { INPUT: 'input', OUTPUT: 'output' },
    formatMultiplayerTurnInput: JSON.stringify, ...extra
  });
  return Object.create(Backend.prototype);
}
describe('stable round recovery', () => {
  it('retransmits captured output without executing any model or discarding acknowledgements', async () => {
    const b = backend();
    const result = { round: 3, input: 'question', output: 'retained' };
    Object.assign(b, { room: { role: 'host', round: { number: 3, status: 'error', lastResult: result, resultAcks: { a: { status: 'ready' } } } },
      broadcastRoundState: vi.fn(), broadcastRoomPacket: vi.fn(), advanceHostRoundAfterResultAcks: vi.fn(),
      appendSessionLog: vi.fn(), emit: vi.fn(), sendModelInputAndCapture: vi.fn() });
    await b.recoverHostRound();
    expect(b.sendModelInputAndCapture).not.toHaveBeenCalled();
    expect(b.broadcastRoomPacket).toHaveBeenLastCalledWith('round-result', result, true);
    expect(b.room.round.resultAcks.a.status).toBe('ready');
    expect(b.roundBusy).toBe(false);
  });
  it('resumes postprocessing with captured source rather than creating a conversation', async () => {
    const b = backend();
    Object.assign(b, { room: { role: 'host', round: { number: 2, status: 'error', generatedResult: { output: 'raw' } } }, maybeRunHostRound: vi.fn() });
    await b.recoverHostRound();
    expect(b.room.round.retryInNewConversation).toBe(false);
    expect(b.maybeRunHostRound).toHaveBeenCalledOnce();
  });
  it('preserves submissions when a model request fails', async () => {
    const b = backend();
    const submissions = { host: { text: 'keep this', displayName: 'Host' } };
    Object.assign(b, {
      workSettings: {}, room: { role: 'host', members: [{ id: 'host' }], round: { number: 1, status: 'collecting', submissions } },
      pluginSettings: { plugins: { perspective: { enabled: false } } },
      broadcastRoundState: vi.fn(), syncHostMultiplayerConversationConfig: vi.fn(),
      runConversationPluginStack: vi.fn(async (_phase, value) => value), broadcastRoomPacket: vi.fn(async () => {}),
      openLiveHostConversation: vi.fn(async () => false), sendModelInputAndCapture: vi.fn(async () => { throw Error('explicit failure'); }),
      emit: vi.fn(), appendSessionLog: vi.fn()
    });
    await b.maybeRunHostRound();
    expect(b.room.round.status).toBe('error');
    expect(b.room.round.submissions).toBe(submissions);
    expect(b.room.round.error).toBe('explicit failure');
    expect(b.roundBusy).toBe(false);
  });
});
describe('editor durable drafts and conflict handling', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'fyow-draft-test-')); directories.push(dir);
    const card = cards.createBundledGridCard(), project = editor.createEditorProject(card);
    const b = Object.assign(backend(), {
      account: { accountId: card.companion.authorAccountId }, origin: card.companion.origin,
      onlineWorldCard: () => card, assertOnlineWorldEditorOwner: vi.fn(),
      onlineWorldEditorProjects: { projects: {} }, onlineWorldEditorFile: join(dir, 'projects.json'),
      listOnlineWorldCards: async () => ({ cards: [card] }), listOnlineWorldEditorProjects: () => ({ projects: [] })
    });
    return { b, project };
  }
  it('rejects stale revisions without altering the newer stored project', async () => {
    const { b, project } = fixture();
    b.onlineWorldEditorProjects.projects.card = { ...project, revision: 4 };
    await expect(b.saveOnlineWorldCardEditor('card', { ...project, revision: 2 })).rejects.toThrow('EDITOR_REVISION_CONFLICT');
    expect(b.onlineWorldEditorProjects.projects.card.revision).toBe(4);
  });
  it('retains backend candidates and invalidates old evidence even if validation rejects', async () => {
    const { b, project } = fixture();
    const candidate = { files: { 'program.html': 'candidate' } };
    b.onlineWorldEditorProjects.projects.card = { ...project, harnessCandidate: candidate };
    project.harness = { evidence: { fingerprint: 'stale' }, review: { approved: true } };
    await expect(b.saveOnlineWorldCardEditor('card', project, { testOnly: true })).rejects.toThrow('专项回归');
    const stored = editor.loadEditorProjects(b.onlineWorldEditorFile).projects.card;
    expect(stored.harnessCandidate).toEqual(candidate);
    expect(stored.harness.evidence).toBeNull();
    expect(stored.revision).toBe(1);
  });
  it('does not adopt a conflicting backend revision after an IPC rejection', async () => {
    const context: any = vm.createContext({ selectedOnlineWorldEditorId: 'A', onlineWorldEditorSaving: false,
      onlineWorldEditorProject: { revision: 2 }, onlineWorldEditorDirty: true, state: {},
      syncOnlineWorldEditorFromForm: () => ({ revision: 2 }), renderOnlineWorldEditorProgress: vi.fn(),
      api: { saveOnlineWorldCardEditor: async () => { throw Error('EDITOR_REVISION_CONFLICT'); }, getOnlineWorldCardEditor: async () => ({ revision: 5 }) }
    });
    vm.runInContext(renderer.slice(renderer.indexOf('async function saveOnlineEditor('), renderer.indexOf('async function preserveOnlineEditorChanges(')), context);
    await expect(context.saveOnlineEditor()).rejects.toThrow('EDITOR_REVISION_CONFLICT');
    expect(context.onlineWorldEditorProject.revision).toBe(2);
    expect(context.onlineWorldEditorDirty).toBe(true);
    expect(context.onlineWorldEditorSaving).toBe(false);
  });
  it('keeps full-configuration edits and detects competing structured edits', () => {
    const original = { app: { name: 'old', summary: '' }, pre_prompt: 'old prompt', world_book: [] };
    const values: any = { 'online-editor-app-name': 'old', 'online-editor-summary': '', 'online-editor-pre-text': '',
      'online-editor-pre-prompt': 'old prompt', 'online-editor-post-text': '', 'online-editor-title': 'title',
      'online-editor-program': 'html', 'online-editor-agent-goal': 'goal', 'online-editor-budget-points': '10' };
    const context: any = vm.createContext({ onlineWorldEditorProject: { card: {}, configuration: original },
      editorValue: (id: string) => values[id], document: { querySelector: () => ({ checked: false }) },
      onlineEditorSessions: () => ({ items: [], activeId: '' }),
      parseEditorJson: (id: string) => id === 'online-editor-config-json' ? { ...original, app: { ...original.app }, pre_prompt: 'raw edit' } : id === 'online-editor-world-book' ? [] : { scenarios: [] }
    });
    vm.runInContext(renderer.slice(renderer.indexOf('function syncOnlineWorldEditorFromForm('), renderer.indexOf('async function saveOnlineEditor(')), context);
    expect(context.syncOnlineWorldEditorFromForm().configuration.pre_prompt).toBe('raw edit');
    values['online-editor-pre-prompt'] = 'competing';
    expect(() => context.syncOnlineWorldEditorFromForm()).toThrow('同时修改');
    expect(original.pre_prompt).toBe('old prompt');
  });
});
describe('online world publication boundaries', () => {
  it.each(['grant-general', 'record-general-dialogue', 'apply-general-appearance', 'surrender-general'])('rejects internal operation %s at public entry', async type => {
    const s = Object.create(OnlineWorldService.prototype);
    await expect(s.submitIntent({ type })).rejects.toThrow('公开操作');
  });
  it('retains sync ownership through uploads instead of overlapping another sync', async () => {
    const s = Object.create(OnlineWorldService.prototype);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    Object.assign(s, { work: { id: 'a' }, syncWithUploads: vi.fn(() => pending) });
    const a = s.sync(), b = s.sync();
    expect(s.syncWithUploads).toHaveBeenCalledOnce();
    expect(s.syncInFlight).toBeTruthy();
    finish(); await Promise.all([a, b]);
    expect(s.syncInFlight).toBeNull();
  });
  it('uploads direct body before wake, and resumes partial delivery without duplicating chunks', async () => {
    const s = Object.create(OnlineWorldService.prototype), calls: string[] = [];
    let fail = true;
    Object.assign(s, { work: { id: 'work' }, account: () => ({ accountId: 'sender' }), directHistory: [],
      ensurePrivateChat: async () => ({ id: 'chat' }), saveCache: vi.fn(), now: () => 1,
      retryPlatformWrite: (fn: any) => fn(), chatContainsContent: async () => false,
      requestConsole: async (_path: string, opts: any) => { calls.push(opts.body.content); if (opts.body.content === 'b' && fail) throw Error('429'); },
      findPublishedRecordSources: async () => [], postRecordNow: async () => { calls.push('wake'); return [{ id: 'wake' }]; }
    });
    const item = { wake: { workId: 'work', fromAccountId: 'sender' }, contents: ['a', 'b'], messageId: 'm', history: { messageId: 'm' } };
    await expect(s.publishDirectOutbox(item)).rejects.toThrow('429');
    expect(calls).toEqual(['a', 'b']);
    fail = false; await s.publishDirectOutbox(item); await s.publishDirectOutbox(item);
    expect(calls).toEqual(['a', 'b', 'b', 'wake']);
    expect(s.directHistory).toHaveLength(1);
  });
});
describe('harness knowledge and editing contracts', () => {
  it('bundles actual source knowledge with explicit design-only boundaries', () => {
    expect(knowledge.readKnowledge('bridge-starter', 0, 500).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(knowledge.readKnowledge('generic-sdk-design').status).toBe('design-only');
    expect(knowledge.searchKnowledge('fyow-host/1').length).toBeGreaterThan(0);
    expect(() => knowledge.readKnowledge('../../credentials')).toThrow('清单');
  });
  it('rejects malformed worldbook entries before paid iteration', () => {
    for (const entry of [{ key: '', value: 'x' }, { key: 'x', value: '' }, { key: 'x', value: 'y', enable: 'yes' }, { key: 'x', value: 'y', probability: 101 }]) {
      expect(() => harness.validateFile('configuration.json', JSON.stringify({ world_book: [entry] }))).toThrow();
    }
  });
  it('declines unsupported multiplayer automatic development before any model call', async () => {
    const request = vi.fn();
    await expect(harness.runGameHarness({ project: editor.createEditorProject(cards.createBundledGridCard()), goal: 'develop', request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('exposes only the narrow generic model bridge and returns usage through the current iframe', () => {
    expect(renderer).toContain('GENERIC_GAME_SOURCE = "fyow-game-card"');
    expect(renderer).toContain('GENERIC_MODEL_PROTOCOL = "fyow-host/2"');
    expect(renderer).toContain('event.data.method!=="model.run"');
    expect(renderer).toContain('api.runStandaloneModel');
    expect(preload).toContain('runStandaloneModel: value => ipcRenderer.invoke("online-world:run-model", value)');
    expect(main).toContain('handleLocalIpc("online-world:run-model"');
    expect(renderer).not.toContain('params.prompt');
    expect(renderer).not.toContain('params.workId');
    expect(renderer).toContain('usage:error?.usage||null');
  });
});
