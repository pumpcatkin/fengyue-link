const { abortable, assertActive } = require("./auto-model-router.cjs");
function modelStreamError(message, retryable = false) {
  const error = new Error(message);
  error.name = "ModelStreamError";
  error.retryable = retryable;
  return error;
}

function answerText(data) {
  const candidates = [
    data?.answer,
    data?.text,
    data?.data?.answer,
    data?.data?.text,
    data?.data?.outputs?.answer,
    data?.data?.outputs?.text
  ];
  return candidates.find(value => typeof value === "string" && value) || "";
}

function createModelRequestPayload({ workId, query, files = [] }) {
  if (!Array.isArray(files) || files.length > 3) throw new Error("模型附件最多 3 个");
  const attachments = files.map(file => {
    if (!["document", "image"].includes(file?.type) || file.transfer_method !== "local_file"
      || !/^[a-zA-Z0-9_-]{1,120}$/.test(String(file.upload_file_id || ""))) throw new Error("模型附件必须来自已验证的本地文件上传结果");
    return { type: file.type, transfer_method: "local_file", upload_file_id: file.upload_file_id };
  });
  const payload = {
    app_id: String(workId || ""),
    inputs: {},
    query: String(query || ""),
    response_mode: "streaming",
    files: attachments
  };
  return payload;
}

// Explicit conversation mode; auxiliary model calls retain their fresh-only contract.
function createConversationModelRequestPayload(options = {}) {
  const { conversationId, messageId, createdAt, isRefresh = false, isUseRefreshCard, inputs } = options;
  const payload = createModelRequestPayload(options);
  if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) payload.inputs = inputs;
  if (conversationId) payload.conversation_id = String(conversationId);
  if (messageId) payload.message_id = String(messageId);
  if (createdAt != null && String(createdAt) !== "") payload.created_at = createdAt;
  if (isRefresh) payload.is_refresh = true;
  if (isUseRefreshCard != null) payload.is_use_refresh_card = Boolean(isUseRefreshCard);
  return payload;
}

function finitePointValue(value) {
  if (value == null || String(value).trim() === "") return null;
  if (typeof value === "string") value = value.replace(/,/g, "").trim();
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pointField(root, names) {
  if (!root || typeof root !== "object") return null;
  const wanted = new Set(names.map(name => String(name).toLowerCase()));
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase())) {
        const number = finitePointValue(child);
        if (number != null) return number;
      }
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

function normalizeModelPoints(value) {
  if (!value || typeof value !== "object") return null;
  const input = pointField(value, ["input_points", "inputPoints", "prompt_points", "promptPoints", "question_points", "questionPoints"]);
  const output = pointField(value, ["output_points", "outputPoints", "completion_points", "completionPoints", "answer_points", "answerPoints"]);
  let total = pointField(value, ["total_points", "totalPoints", "points_used", "pointsUsed", "consumed_points", "consumedPoints", "consume_points", "consumePoints", "point_cost", "pointCost", "cost_points", "costPoints"]);
  if (total == null && (input != null || output != null)) total = Number(input || 0) + Number(output || 0);
  if (input == null && output == null && total == null) return null;
  return {
    input,
    output,
    total,
    source: "model-response"
  };
}

async function consumeModelEventStream(body, { signal, onEvent = () => {}, allowEmpty = false, confirmStopped = async () => false } = {}) {
  assertActive(signal);
  if (!body || typeof body.getReader !== "function") throw modelStreamError("模型响应缺少数据流");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let taskId = null;
  let messageId = null;
  let conversationId = null;
  let usage = null;
  let points = null;
  let finished = false;
  let finishEvent = null;

  const acceptBlock = block => {
    const payloadText = String(block || "")
      .split("\n")
      .filter(line => line.trimStart().startsWith("data:"))
      .map(line => line.slice(line.indexOf("data:") + 5).trimStart())
      .join("\n")
      .trim();
    if (!payloadText) return;
    if (payloadText === "[DONE]") {
      finished = true;
      finishEvent = "done";
      return;
    }
    if (["ping", "[ping]", "keepalive", "[keepalive]"].includes(payloadText.toLowerCase())) return;
    let data;
    try { data = JSON.parse(payloadText); } catch { throw modelStreamError("模型数据流包含无效事件"); }
    const event = String(data?.event || data?.type || "");
    if (event === "error") throw modelStreamError(data?.message || data?.error || "模型流返回错误", true);
    taskId ||= data?.task_id || data?.taskId || null;
    messageId ||= data?.message_id || data?.messageId || (/^(message|agent_message|message_end|message_replace)$/.test(event) ? data?.id : null) || null;
    conversationId ||= data?.conversation_id || data?.conversationId || null;
    onEvent({ event, taskId, messageId, conversationId });
    const text = answerText(data);
    if (text) {
      if (["message_replace", "text_replace"].includes(event)) answer = text;
      else answer += text;
    }
    const eventUsage = data?.metadata?.usage || data?.usage || data?.data?.usage || null;
    usage = eventUsage || usage;
    points = normalizeModelPoints(eventUsage) || normalizeModelPoints(data?.metadata) || points;
    if (["message_end", "workflow_finished"].includes(event)) {
      finished = true;
      finishEvent = event;
    }
  };

  try {
    while (!finished) {
      const chunk = await abortable(() => reader.read(), signal);
      buffer = `${buffer}${decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })}`.replace(/\r\n/g, "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        acceptBlock(block);
        if (finished) break;
      }
      if (chunk.done) {
        if (buffer.trim()) acceptBlock(buffer);
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!finished && taskId && messageId && conversationId && await confirmStopped()) {
    finished = true;
    finishEvent = "server_stop";
  }
  if (!finished) throw modelStreamError("模型响应在完成标记前提前结束");
  if (!answer.trim() && !allowEmpty) throw modelStreamError("模型完成后没有返回正文");
  return { answer: answer.trim(), taskId, messageId, conversationId, usage, points, finishEvent };
}

module.exports = { consumeModelEventStream, createModelRequestPayload, createConversationModelRequestPayload, normalizeModelPoints };
