// These are the same installed-app endpoints used by the platform's
// delConversation and renameConversation buttons. Never rename a local label
// and report success without checking the server's conversation list.
function readPlatformConversationItems(payload) {
  const queue = [payload];
  for (let index = 0; index < queue.length && index < 50; index += 1) {
    const value = queue[index];
    if (Array.isArray(value)) {
      if (value.some(record => !record || typeof record !== "object" || !(record.id || record.conversation_id || record.conversationId || record.uuid))) continue;
      return value.map(record => ({
        id: String(record.id ?? record.conversation_id ?? record.conversationId ?? record.uuid),
        name: String(record.name ?? record.title ?? record.conversation_name ?? record.conversationName ?? "未命名会话"),
        active: Boolean(record.active ?? record.is_active ?? record.isActive ?? record.selected ?? record.current)
      }));
    }
    if (value && typeof value === "object") {
      for (const key of ["conversations", "items", "list", "data", "result"]) {
        if (value[key] && typeof value[key] === "object") queue.push(value[key]);
      }
    }
  }
  throw new Error("平台会话列表格式无法识别，未使用本地列表代替校验");
}

async function mutatePlatformConversation(api, { appId, id, action, name }, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!["rename", "delete"].includes(action)) throw new Error("不支持的会话操作");
  if (!appId || !id) throw new Error("请先选择已保存的平台会话");
  const newName = String(name || "").trim();
  if (action === "rename" && !newName) throw new Error("会话名称不能为空");
  const base = `/installed-apps/${encodeURIComponent(appId)}/conversations`;
  const read = async () => readPlatformConversationItems(await api(`${base}?limit=500`));
  const before = await read();
  if (!before.some(item => item.id === id)) throw new Error("平台中找不到该会话，请刷新会话列表");
  await api(`${base}/${encodeURIComponent(id)}${action === "rename" ? "/name" : ""}`, {
    method: action === "rename" ? "POST" : "DELETE",
    ...(action === "rename" ? { body: { name: newName } } : {})
  });
  let detail = "平台列表尚未更新";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const items = await read();
      const target = items.find(item => item.id === id);
      if (action === "delete" ? !target : target?.name === newName) return { items, name: newName };
    } catch (error) { detail = error.message; }
    if (attempt < 4) await wait(350);
  }
  throw new Error(`平台操作已提交，但暂时无法确认结果：${detail}。请刷新查看，不要重复提交。`);
}

function updateConversationAnchors(store, appId, id, name, resolveWorkId) {
  for (const [key, saved] of Object.entries(store.sessions || {})) {
    if (String(saved.conversationId || "") !== id || resolveWorkId(saved.workSuffix) !== appId) continue;
    if (name === null) delete store.sessions[key];
    else { saved.name = name; saved.updatedAt = Date.now(); }
  }
  if (name === null) for (const [work, hosts] of Object.entries(store.hosts || {})) {
    if (resolveWorkId(work) === appId) delete hosts[id];
  }
}

module.exports = { readPlatformConversationItems, mutatePlatformConversation, updateConversationAnchors };
