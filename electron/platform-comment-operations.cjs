"use strict";

const COMMENT_CONTENT_LIMIT = 980;

function commentId(value) {
  return String(value?.id || value?.comment_id || value?.data?.id || value?.data?.comment_id || "").trim();
}

function commentAccountId(value) {
  return String(value?.account_id || value?.accountId || value?.created_by_account_id || value?.from_account_id
    || value?.account?.id || value?.user?.id || value?.author?.id || value?.created_by?.id || value?.sender?.id || "").trim();
}

function commentParentId(value) {
  const id = commentId(value);
  const parentId = String(value?.parent_id || value?.parentId || value?._fyowRootId
    || value?.root_comment_id || value?.rootCommentId || "").trim();
  // Some platform responses set root_comment_id to the root's own ID. It must
  // still be classified as a root so only the whole-branch flow can delete it.
  return parentId && parentId !== id ? parentId : "";
}

function boundedId(value, label) {
  const id = String(value || "").trim();
  if (!id || id.length > 160 || /[\x00-\x20/?#\\]/u.test(id)) throw new Error(`${label}无效`);
  return id;
}

class PlatformCommentOperations {
  constructor({ requestConsole, getAccount, getActiveWorkId, resolveComments, sleep }) {
    if (typeof requestConsole !== "function") throw new TypeError("评论操作缺少平台请求接口");
    this.requestConsole = requestConsole;
    this.getAccount = typeof getAccount === "function" ? getAccount : () => ({});
    this.getActiveWorkId = typeof getActiveWorkId === "function" ? getActiveWorkId : () => "";
    this.resolveComments = typeof resolveComments === "function" ? resolveComments : null;
    this.sleep = typeof sleep === "function" ? sleep : delay => new Promise(resolve => setTimeout(resolve, delay));
  }

  assertActiveWork(workId) {
    const requested = boundedId(workId, "作品编号");
    const active = boundedId(this.getActiveWorkId(), "当前作品编号");
    if (requested !== active) throw new Error("评论操作只能用于当前打开的作品");
    return requested;
  }

  async publish({ workId, content, parentId = "", toAccountId = "", toCommentId = "" }) {
    const activeWorkId = this.assertActiveWork(workId);
    const text = String(content || "");
    if (!text || text.length > COMMENT_CONTENT_LIMIT) throw new Error(`评论数据必须为 1～${COMMENT_CONTENT_LIMIT} 字符`);
    const body = { is_anonymous: false, biz_type: 1, content: text };
    if (parentId) {
      body.parent_id = boundedId(parentId, "父评论编号");
      body.to_account_id = toAccountId ? boundedId(toAccountId, "目标账号编号") : "";
      if (toCommentId) body.to_comment_id = boundedId(toCommentId, "目标评论编号");
    }
    return this.requestConsole(`/comments/${encodeURIComponent(activeWorkId)}/1`, { method: "POST", body, timeout: 20000 });
  }

  async delete({ workId, source, deleteRoot = false }) {
    const result = await this.deleteMany({ workId, sources: [source], deleteRoots: deleteRoot });
    return {
      deleted: result.deletedCommentIds.length === 1 || result.alreadyMissingCommentIds.length === 1,
      alreadyMissing: result.alreadyMissingCommentIds.length === 1,
      commentId: result.commentIds[0],
      preservedRoot: result.preservedRootCommentIds.length === 1
    };
  }

  async freshComments(ids, sources = [], options = {}) {
    if (!this.resolveComments) {
      const error = new Error("删除前的云端校验接口不可用");
      error.code = "PLATFORM_DELETE_VERIFICATION_UNAVAILABLE";
      throw error;
    }
    const result = await this.resolveComments(ids, sources, options);
    if (!result || result.complete !== true || !Array.isArray(result.items)) {
      const error = new Error("云端评论读取尚未完整，已保留原数据");
      error.code = "PLATFORM_DELETE_VERIFICATION_INCOMPLETE";
      throw error;
    }
    return result.items;
  }

  assertContext(workId, accountId) {
    if (this.assertActiveWork(workId) !== workId || String(this.getAccount()?.accountId || "").trim() !== accountId) {
      const error = new Error("评论删除期间账号或作品已经切换");
      error.code = "PLATFORM_DELETE_CONTEXT_CHANGED";
      throw error;
    }
  }

  async deleteMany({ workId, sources, knownOwnedCommentIds = [], deleteRoots = false }) {
    const activeWorkId = this.assertActiveWork(workId);
    const requested = [];
    const seen = new Set();
    for (const [index, source] of (sources || []).entries()) {
      const id = boundedId(commentId(source), "评论编号");
      if (seen.has(id)) continue;
      seen.add(id);
      requested.push({ id, source, index });
    }
    if (!requested.length) throw new Error("至少需要一条待删除评论");
    if (requested.length > 1024) throw new Error("单次评论删除数量超过上限");
    const currentAccountId = String(this.getAccount()?.accountId || "").trim();
    if (!currentAccountId) throw new Error("当前账号尚未完成认证");

    const ids = requested.map(item => item.id);
    const knownOwned = new Set((knownOwnedCommentIds || []).map(String));
    const sourceItems = requested.map(item => item.source);
    const freshItems = await this.freshComments(ids, sourceItems, {
      requireCompleteBranches: Boolean(deleteRoots)
    });
    const freshById = new Map(freshItems.map(item => [commentId(item), item]));
    for (const item of requested) {
      const fresh = freshById.get(item.id);
      if (!fresh) {
        if (knownOwned.has(item.id) && commentAccountId(item.source) === currentAccountId) continue;
        const error = new Error("云端未找到待删除评论，已保留原数据");
        error.code = "PLATFORM_DELETE_NOT_CONFIRMED";
        throw error;
      }
      const authorAccountId = commentAccountId(fresh);
      if (!authorAccountId || authorAccountId !== currentAccountId) throw new Error("只能删除当前账号发布的评论");
      if (commentParentId(item.source) !== commentParentId(fresh)) {
        const error = new Error("评论层级在删除前发生变化，已保留原数据");
        error.code = "PLATFORM_DELETE_RELATION_CHANGED";
        throw error;
      }
    }

    // Classify roots and replies only from the fresh cloud response. Persisted
    // source metadata is evidence, not authority over a destructive target.
    // The platform DELETE endpoint is not atomic: a live probe confirmed that
    // deleting a root with replies returns 200 and removes the whole branch.
    // Therefore roots are never sent to DELETE at runtime. Keeping the root is
    // the only way to guarantee that a concurrent/foreign reply cannot be
    // destroyed by a cleanup operation.
    const deletionTargets = requested.filter(item => {
      const fresh = freshById.get(item.id);
      return fresh ? Boolean(commentParentId(fresh)) : false;
    });
    const preservedRootCommentIds = requested.filter(item => {
      const fresh = freshById.get(item.id);
      return fresh ? !commentParentId(fresh) : !commentParentId(item.source);
    }).map(item => item.id);
    const alreadyMissingCommentIds = requested.filter(item => !freshById.has(item.id)).map(item => item.id);
    const replyTargets = deletionTargets.filter(item => commentParentId(freshById.get(item.id)));
    if (!deletionTargets.length && !alreadyMissingCommentIds.length) {
      return {
        deleted: true,
        fullyDeleted: false,
        commentIds: ids,
        deletedCommentIds: [],
        alreadyMissingCommentIds: [],
        preservedRootCommentIds
      };
    }

    const deletedCommentIds = [];
    for (const item of replyTargets) {
      this.assertContext(activeWorkId, currentAccountId);
      if (!freshById.has(item.id)) {
        alreadyMissingCommentIds.push(item.id);
        continue;
      }
      try {
        await this.requestConsole(`/comments/${encodeURIComponent(activeWorkId)}/1/${encodeURIComponent(item.id)}`, {
          method: "DELETE", timeout: 20000
        });
        deletedCommentIds.push(item.id);
      } catch (error) {
        if (Number(error?.status) === 404) {
          alreadyMissingCommentIds.push(item.id);
          continue;
        }
        throw error;
      }
    }

    const targetIds = deletionTargets.map(item => item.id);
    let remainingIds = [];
    if (targetIds.length) {
      remainingIds = targetIds;
      for (const delay of [0, 300, 700, 1500]) {
        if (delay) await this.sleep(delay);
        this.assertContext(activeWorkId, currentAccountId);
        remainingIds = (await this.freshComments(targetIds, sourceItems, {
          requireCompleteBranches: Boolean(deleteRoots)
        })).map(commentId).filter(id => targetIds.includes(id));
        if (!remainingIds.length) break;
      }
    }
    if (remainingIds.length) {
      const error = new Error("平台尚未确认评论已删除");
      error.code = "PLATFORM_DELETE_UNCONFIRMED";
      error.status = 409;
      error.remainingCommentIds = remainingIds;
      throw error;
    }
    return {
      deleted: true,
      fullyDeleted: preservedRootCommentIds.length === 0,
      commentIds: ids,
      deletedCommentIds,
      alreadyMissingCommentIds,
      preservedRootCommentIds
    };
  }
}

module.exports = { PlatformCommentOperations, commentId, commentAccountId, commentParentId, COMMENT_CONTENT_LIMIT };
