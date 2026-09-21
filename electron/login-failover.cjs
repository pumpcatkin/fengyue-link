function orderLoginCandidates(domains, { includeUnmeasured = false, preferredOrigin = "" } = {}) {
  const unique = new Map();
  for (const item of Array.isArray(domains) ? domains : []) {
    if (!item || (item.online !== true && !(includeUnmeasured && item.online == null) && item.origin !== preferredOrigin)) continue;
    const origin = String(item.finalOrigin || item.origin || "").trim();
    if (!origin) continue;
    const latency = item.latency == null ? NaN : Number(item.latency);
    const candidate = {
      origin,
      latency: Number.isFinite(latency) && latency >= 0 ? latency : Number.MAX_SAFE_INTEGER
    };
    const previous = unique.get(origin);
    if (!previous || candidate.latency < previous.latency) unique.set(origin, candidate);
  }
  return [...unique.values()].sort((left, right) => Number(right.origin === preferredOrigin) - Number(left.origin === preferredOrigin)
    || left.latency - right.latency || left.origin.localeCompare(right.origin));
}

function loginError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertLoginActive(signal) {
  if (signal?.aborted) throw signal.reason || loginError("LOGIN_CANCELLED", "登录已取消");
}

function waitForLoginTask(task, signal) {
  if (signal?.aborted) {
    Promise.resolve(task).catch(() => {});
    return Promise.reject(signal.reason || loginError("LOGIN_CANCELLED", "登录已取消"));
  }
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason || loginError("LOGIN_CANCELLED", "登录已取消"));
    signal?.addEventListener("abort", cancelled, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal?.removeEventListener("abort", cancelled));
  });
}

function pauseLogin(ms, signal) {
  assertLoginActive(signal);
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      reject(signal.reason || loginError("LOGIN_CANCELLED", "登录已取消"));
    };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancelled); resolve(); }, ms);
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function platformLoginError(message) {
  const rejected = /密码|不存在|封禁|锁定|禁用|频繁|验证码|captcha|password|credentials|too many|rate limit|\b429\b/i.test(message);
  const transport = !rejected && /网络|连接|超时|繁忙|稍后|network|fetch|timeout|timed out|\b(?:502|503|504)\b/i.test(message);
  return loginError(transport ? "LOGIN_NODE_FAILED" : "LOGIN_REJECTED", `平台登录失败：${message}`);
}

async function runLoginFailover({ signal, getCandidates, refreshCandidates, attempt, onProgress = () => {}, nodeWaitMs = round => Math.min(60000, 25000 + round * 15000), retryDelayMs = round => Math.min(15000, 2500 * (round + 1)) }) {
  let attemptNumber = 0;
  for (let round = 0; ; round += 1) {
    assertLoginActive(signal);
    let candidates = [...await waitForLoginTask(getCandidates(round), signal)];
    const attemptedOrigins = new Set();
    while (candidates.length) {
      const candidate = candidates.shift();
      if (attemptedOrigins.has(candidate.origin)) continue;
      attemptedOrigins.add(candidate.origin);
      assertLoginActive(signal);
      const node = new AbortController();
      const cancelNode = () => node.abort(signal.reason);
      signal?.addEventListener("abort", cancelNode, { once: true });
      // A slow node is replaced; the overall login has no deadline or attempt cap.
      const timer = setTimeout(() => node.abort(loginError("LOGIN_NODE_STALLED", "节点响应较慢，正在切换节点")), nodeWaitMs(round));
      try {
        onProgress({ phase: "connecting", origin: candidate.origin, attempt: ++attemptNumber, round: round + 1 });
        const result = await waitForLoginTask(attempt(candidate, node.signal), node.signal);
        assertLoginActive(signal);
        return result;
      } catch (error) {
        assertLoginActive(signal);
        if (error?.code === "LOGIN_REJECTED") throw error;
        onProgress({ phase: "switching", origin: candidate.origin, attempt: attemptNumber, round: round + 1, error: error?.message || String(error) });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelNode);
        if (!node.signal.aborted) node.abort(loginError("LOGIN_NODE_FINISHED", "节点尝试已结束"));
      }
      if (refreshCandidates) candidates = (await waitForLoginTask(refreshCandidates(round), signal)).filter(item => !attemptedOrigins.has(item.origin));
    }
    onProgress({ phase: "waiting", attempt: attemptNumber, round: round + 1 });
    await pauseLogin(retryDelayMs(round), signal);
  }
}

module.exports = { orderLoginCandidates, loginError, assertLoginActive, waitForLoginTask, pauseLogin, platformLoginError, runLoginFailover };
