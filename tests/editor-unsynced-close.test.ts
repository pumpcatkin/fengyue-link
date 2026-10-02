import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const editor = require("../electron/online-game-editor.cjs");
const cards = require("../electron/online-world-card.cjs");
const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");

function closeFlowContext({ dirty = false, project, action = "local", save = vi.fn(async () => {}) }: any) {
  const choose = vi.fn(async () => action);
  const context: any = vm.createContext({
    onlineWorldEditorSaving: false,
    onlineWorldEditorDirty: dirty,
    onlineWorldEditorProject: project,
    selectedOnlineWorldEditorId: project ? "current-project" : null,
    onlineWorldEditorProjects: [],
    onlineWorldEditorCards: [],
    onlineWorldEditorExitPromise: null,
    api: { chooseOnlineWorldEditorCloseAction: choose, listOnlineWorldEditorProjects: vi.fn(), getOnlineWorldCardEditor: vi.fn() },
    saveOnlineEditor: save,
    confirmAction: vi.fn(),
    toast: vi.fn(),
    showPage: vi.fn(),
    renderOnlineWorldEditorProjects: vi.fn(),
    renderOnlineWorldEditorProject: vi.fn(),
    friendlyError: (error: any) => error?.message || String(error)
  });
  vm.runInContext(
    renderer.slice(renderer.indexOf("function onlineEditorPendingUploadProjects("), renderer.indexOf("async function refreshOnlineWorldEditorCards(")),
    context
  );
  return { context, choose, save };
}

describe("editor unpublished close flow", () => {
  it("persists whether a project still needs upload", () => {
    const draft = editor.createBlankEditorProject();
    expect(editor.editorProjectHasPendingUpload(draft)).toBe(true);

    const published = editor.createEditorProject(cards.createBundledGridCard());
    expect(editor.editorProjectHasPendingUpload(published)).toBe(false);

    editor.markEditorProjectPendingUpload(published);
    const restored = editor.normalizeEditorProject(JSON.parse(JSON.stringify(published)));
    expect(editor.editorProjectHasPendingUpload(restored)).toBe(true);

    editor.markEditorProjectUploaded(restored, 1234);
    expect(editor.editorProjectHasPendingUpload(restored)).toBe(false);
    expect(restored.publication).toMatchObject({ status: "synced", syncedAt: 1234 });

    expect(editor.normalizeEditorProject({ revision: 0, isDraft: false }).publication.status).toBe("synced");
    expect(editor.normalizeEditorProject({ revision: 1, isDraft: false }).publication.status).toBe("pending");
  });

  it("prompts for saved pending projects even before the editor has been opened", async () => {
    const local = closeFlowContext({ project: null, action: "local" });
    await expect(local.context.preserveOnlineEditorChanges({
      pendingProjects: [{ libraryId: "draft::saved", title: "未打开的草稿", isDraft: true }]
    })).resolves.toBe(true);
    expect(local.choose).toHaveBeenCalledWith(expect.objectContaining({
      pendingCount: 1,
      pendingTitles: ["未打开的草稿"],
      canPublishCurrent: false
    }));
    expect(local.save).not.toHaveBeenCalled();
  });

  it("saves a dirty current form before opening another pending project for review", async () => {
    const review = closeFlowContext({
      dirty: true,
      project: { card: { title: "当前项目" }, isDraft: false, publication: { status: "synced" } },
      action: "review"
    });
    review.context.api.listOnlineWorldEditorProjects.mockResolvedValue({ projects: [{ libraryId: "draft::other", isDraft: true }] });
    review.context.api.getOnlineWorldCardEditor.mockResolvedValue({ card: { title: "其他草稿" }, isDraft: true, publication: { status: "pending" } });
    await expect(review.context.preserveOnlineEditorChanges({
      pendingProjects: [{ libraryId: "draft::other", title: "其他草稿", isDraft: true }]
    })).resolves.toBe(false);
    expect(review.save).toHaveBeenCalledWith({ publish: false });
    expect(review.context.api.getOnlineWorldCardEditor).toHaveBeenCalledWith("draft::other");
    expect(review.save.mock.invocationCallOrder[0]).toBeLessThan(review.context.api.getOnlineWorldCardEditor.mock.invocationCallOrder[0]);
  });

  it("does not prompt for a clean project whose cloud version is current", async () => {
    const { context, choose, save } = closeFlowContext({
      project: { isDraft: false, publication: { status: "synced" } }
    });
    await expect(context.preserveOnlineEditorChanges()).resolves.toBe(true);
    expect(choose).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("supports local save, upload, and cancel as distinct close outcomes", async () => {
    const local = closeFlowContext({
      dirty: true,
      project: { isDraft: false, publication: { status: "synced" } },
      action: "local"
    });
    await expect(local.context.preserveOnlineEditorChanges()).resolves.toBe(true);
    expect(local.save).toHaveBeenCalledWith({ publish: false });

    const publish = closeFlowContext({
      project: { isDraft: false, publication: { status: "pending" } },
      action: "publish"
    });
    await expect(publish.context.preserveOnlineEditorChanges()).resolves.toBe(true);
    expect(publish.save).toHaveBeenCalledWith({ publish: true });

    const cancel = closeFlowContext({
      dirty: true,
      project: { isDraft: true, publication: { status: "pending" } },
      action: "cancel"
    });
    await expect(cancel.context.preserveOnlineEditorChanges()).resolves.toBe(false);
    expect(cancel.save).not.toHaveBeenCalled();
  });

  it("shares one decision and one upload across concurrent close requests", async () => {
    let release!: (value: string) => void;
    const decision = new Promise<string>(resolve => { release = resolve; });
    const save = vi.fn(async () => {});
    const choose = vi.fn(() => decision);
    const context: any = vm.createContext({
      onlineWorldEditorSaving: false,
      onlineWorldEditorDirty: false,
      onlineWorldEditorProject: { isDraft: false, publication: { status: "pending" } },
      selectedOnlineWorldEditorId: "current-project",
      onlineWorldEditorExitPromise: null,
      api: { chooseOnlineWorldEditorCloseAction: choose },
      saveOnlineEditor: save,
      confirmAction: vi.fn(), toast: vi.fn(), friendlyError: String
    });
    vm.runInContext(
      renderer.slice(renderer.indexOf("function onlineEditorPendingUploadProjects("), renderer.indexOf("async function refreshOnlineWorldEditorCards(")),
      context
    );
    const first = context.preserveOnlineEditorChanges();
    const second = context.preserveOnlineEditorChanges();
    release("publish");
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(choose).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("collects every persisted pending project before requesting renderer close", () => {
    const sent: any[] = [];
    const close = vi.fn();
    const context: any = vm.createContext({
      __dirname: "D:/fixture",
      path: { resolve: (...parts: string[]) => parts.join("/") },
      crypto: { randomUUID: () => "close-request-id" },
      dialog: { showMessageBox: vi.fn() },
      app: { quit: vi.fn() },
      editorProjectHasPendingUpload: editor.editorProjectHasPendingUpload,
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      _mainWindow: {
        isDestroyed: () => false,
        close,
        webContents: { isDestroyed: () => false, send: (...args: any[]) => sent.push(args) }
      },
      _backend: {
        onlineWorldEditorProjects: {
          projects: {
            synced: { card: { title: "已同步" }, publication: { status: "synced" } },
            pending: { card: { title: "待上传" }, publication: { status: "pending" } },
            "draft::local": { card: { title: "本地草稿" }, isDraft: true }
          }
        }
      }
    });
    vm.runInContext(main.slice(main.indexOf("let mainWindow;"), main.indexOf("function closeAllApplicationWindows(")), context);
    vm.runInContext("mainWindow=_mainWindow;backend=_backend;mainWindowCloseRendererReady=true;mainWindowCloseRendererEverReady=true;requestMainWindowClose();", context);

    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe("app:close-requested");
    expect(sent[0][1]).toMatchObject({
      requestId: "close-request-id",
      pendingProjects: [
        { libraryId: "pending", title: "待上传" },
        { libraryId: "draft::local", title: "本地草稿", isDraft: true }
      ]
    });
    expect(vm.runInContext('acknowledgeMainWindowClose("close-request-id")', context)).toBe(true);
    expect(vm.runInContext('resolveMainWindowClose("close-request-id",false)', context)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("routes native window close through the renderer before destruction", () => {
    expect(main).toContain('mainWindow.on("close", event => {');
    expect(main).toContain('mainWindow.webContents.send("app:close-requested"');
    expect(main).toContain("pendingEditorUploadProjects()");
    expect(main).toContain("MAIN_WINDOW_CLOSE_ACK_TIMEOUT_MS");
    expect(main).toContain("fallbackMainWindowClose");
    expect(main).toContain('handleLocalIpc("app:close-ready"');
    expect(main).toContain('handleLocalIpc("app:ack-close"');
    expect(main).toContain('handleLocalIpc("app:resolve-close"');
    expect(preload).toContain('onAppCloseRequested: callback => ipcRenderer.on("app:close-requested"');
    expect(preload).toContain('notifyAppCloseReady: () => ipcRenderer.invoke("app:close-ready")');
    expect(renderer).toContain("api.onAppCloseRequested");
    expect(renderer).toContain("api.acknowledgeAppClose(requestId)");
    expect(renderer).toContain("libraryId!==selectedOnlineWorldEditorId&&onlineEditorHasPendingUpload()&&!await preserveOnlineEditorChanges()");
    expect(renderer).toMatch(/#online-editor-create-blank[\s\S]{0,160}preserveOnlineEditorChanges\(\)/);
    expect(renderer).toMatch(/#online-editor-import[\s\S]{0,160}preserveOnlineEditorChanges\(\)/);
  });
});
