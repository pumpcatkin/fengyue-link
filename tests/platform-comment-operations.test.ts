import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { PlatformCommentOperations } = require("../electron/platform-comment-operations.cjs");

function operations(overrides: Record<string, unknown> = {}) {
  return new PlatformCommentOperations({
    requestConsole: vi.fn(async () => ({})),
    getAccount: () => ({ accountId: "self" }),
    getActiveWorkId: () => "work",
    sleep: async () => {},
    ...overrides
  });
}

describe("platform comment operations", () => {
  it("publishes only to the active work with bounded native reply routing", async () => {
    const requestConsole = vi.fn(async () => ({ id: "posted" }));
    const adapter = operations({ requestConsole });
    await adapter.publish({ workId: "work", content: "hello", parentId: "root", toAccountId: "target" });
    expect(requestConsole).toHaveBeenCalledWith("/comments/work/1", {
      method: "POST",
      body: { is_anonymous: false, biz_type: 1, content: "hello", parent_id: "root", to_account_id: "target" },
      timeout: 20000
    });
    await expect(adapter.publish({ workId: "other", content: "hello" })).rejects.toThrow(/当前打开的作品/);
  });

  it("validates an entire own-comment batch, deletes replies, and preserves the root", async () => {
    const stored = new Map([
      ["reply", { id: "reply", account_id: "self", parent_id: "root" }],
      ["root", { id: "root", account_id: "self", root_comment_id: "root" }]
    ]);
    const requestConsole = vi.fn(async (endpoint: string, options: any) => {
      if (options.method === "DELETE") stored.delete(endpoint.split("/").at(-1) || "");
      return {};
    });
    const resolveComments = vi.fn(async (ids: string[]) => ({ items: ids.map(id => stored.get(id)).filter(Boolean), complete: true }));
    const adapter = operations({ requestConsole, resolveComments });
    const result = await adapter.deleteMany({
      workId: "work",
      sources: [{ id: "root" }, { id: "reply", parent_id: "root" }]
    });
    expect(result).toMatchObject({
      deletedCommentIds: ["reply"], alreadyMissingCommentIds: [], preservedRootCommentIds: ["root"]
    });
    expect(requestConsole.mock.calls.map(call => call[0])).toEqual(["/comments/work/1/reply"]);
    expect(resolveComments).toHaveBeenCalledTimes(2);
  });

  it("rejects a mixed-author batch before issuing any deletion", async () => {
    const requestConsole = vi.fn(async () => ({}));
    const adapter = operations({
      requestConsole,
      resolveComments: async () => ({
        items: [
          { id: "own", account_id: "self", parent_id: "root" },
          { id: "foreign", account_id: "other", parent_id: "root" }
        ],
        complete: true
      })
    });
    await expect(adapter.deleteMany({
      workId: "work",
      sources: [{ id: "own", parent_id: "root" }, { id: "foreign", parent_id: "root" }]
    })).rejects.toThrow(/当前账号/);
    expect(requestConsole).not.toHaveBeenCalled();
  });

  it("uses the fresh cloud relationship and rejects stale parent metadata", async () => {
    const requestConsole = vi.fn(async () => ({}));
    const adapter = operations({
      requestConsole,
      resolveComments: async () => ({ items: [{ id: "target", account_id: "self" }], complete: true })
    });
    await expect(adapter.deleteMany({
      workId: "work",
      sources: [{ id: "target", account_id: "self", parent_id: "cached-root" }]
    })).rejects.toMatchObject({ code: "PLATFORM_DELETE_RELATION_CHANGED" });
    expect(requestConsole).not.toHaveBeenCalled();
  });

  it("keeps the root when a reply branch changes during deletion", async () => {
    const stored = new Map([
      ["reply", { id: "reply", account_id: "self", parent_id: "root" }],
      ["root", { id: "root", account_id: "self" }]
    ]);
    const requestConsole = vi.fn(async (endpoint: string, options: any) => {
      if (options.method === "DELETE") stored.delete(endpoint.split("/").at(-1) || "");
      return {};
    });
    const resolveComments = vi.fn(async (ids: string[]) => {
      if (resolveComments.mock.calls.length > 1) {
        const error = new Error("评论分支在删除前发生变化，已保留原数据");
        (error as Error & { code?: string }).code = "PLATFORM_DELETE_BRANCH_CHANGED";
        throw error;
      }
      return { items: ids.map(id => stored.get(id)).filter(Boolean), complete: true };
    });
    const adapter = operations({ requestConsole, resolveComments });

    await expect(adapter.deleteMany({
      workId: "work",
      sources: [{ id: "reply", parent_id: "root" }, { id: "root" }]
    })).rejects.toMatchObject({ code: "PLATFORM_DELETE_BRANCH_CHANGED" });
    expect(requestConsole.mock.calls.map(call => call[0])).toEqual(["/comments/work/1/reply"]);
    expect(stored.has("root")).toBe(true);
  });

  it("rejects standalone root deletion until the platform supports an atomic condition", async () => {
    const requestConsole = vi.fn(async () => ({}));
    const adapter = operations({
      requestConsole,
      resolveComments: async () => ({ items: [{ id: "root", account_id: "self" }], complete: true })
    });
    await expect(adapter.delete({ workId: "work", source: { id: "root" } })).rejects.toMatchObject({
      code: "PLATFORM_DELETE_ROOT_UNSAFE"
    });
    expect(requestConsole).not.toHaveBeenCalled();
  });

  it("requires prior ownership proof for a missing comment and rejects an unconfirmed deletion", async () => {
    const missing = operations({ resolveComments: async () => ({ items: [], complete: true }) });
    await expect(missing.delete({ workId: "work", source: { id: "gone", parent_id: "root" } })).rejects.toMatchObject({ code: "PLATFORM_DELETE_NOT_CONFIRMED" });
    await expect(missing.deleteMany({
      workId: "work", sources: [{ id: "gone", account_id: "self", parent_id: "root" }], knownOwnedCommentIds: ["gone"]
    })).resolves.toMatchObject({ alreadyMissingCommentIds: ["gone"] });

    const requestConsole = vi.fn(async () => ({}));
    const remaining = operations({ requestConsole, resolveComments: async () => ({ items: [{ id: "stuck", account_id: "self", parent_id: "root" }], complete: true }) });
    await expect(remaining.delete({ workId: "work", source: { id: "stuck", parent_id: "root" } })).rejects.toMatchObject({ code: "PLATFORM_DELETE_UNCONFIRMED" });
    expect(requestConsole).toHaveBeenCalledOnce();
  });

  it("finishes a resumed batch when every proven reply is already gone and only the root remains", async () => {
    const requestConsole = vi.fn(async () => ({}));
    const adapter = operations({
      requestConsole,
      resolveComments: async () => ({ items: [{ id: "root", account_id: "self" }], complete: true })
    });
    await expect(adapter.deleteMany({
      workId: "work",
      sources: [
        { id: "reply", account_id: "self", parent_id: "root" },
        { id: "root", account_id: "self" }
      ],
      knownOwnedCommentIds: ["reply", "root"]
    })).resolves.toMatchObject({
      deletedCommentIds: [], alreadyMissingCommentIds: ["reply"], preservedRootCommentIds: ["root"]
    });
    expect(requestConsole).not.toHaveBeenCalled();
  });

  it("keeps all data when the ownership scan is incomplete", async () => {
    const requestConsole = vi.fn(async () => ({}));
    const adapter = operations({ requestConsole, resolveComments: async () => ({ items: [], complete: false }) });
    await expect(adapter.deleteMany({ workId: "work", sources: [{ id: "comment", parent_id: "root" }] })).rejects.toMatchObject({
      code: "PLATFORM_DELETE_VERIFICATION_INCOMPLETE"
    });
    expect(requestConsole).not.toHaveBeenCalled();
  });
});
