function modelStreamError(message) {
  const error = new Error(message);
  error.name = "ModelStreamError";
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

function createModelRequestPayload({ workId, query }) {
  return {
    app_id: String(workId || ""),
    inputs: {},
    query: String(query || ""),
    response_mode: "streaming",
    files: []
  };
}

function finitePointValue(value) {
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

async function consumeModelEventStream(body) {
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
    if (event === "error") throw modelStreamError(data?.message || data?.error || "模型流返回错误");
    taskId ||= data?.task_id || data?.taskId || null;
    messageId ||= data?.message_id || data?.messageId || null;
    conversationId ||= data?.conversation_id || data?.conversationId || null;
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
      const chunk = await reader.read();
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
    if (finished) await reader.cancel().catch(() => {});
  }
  if (!finished) throw modelStreamError("模型响应在完成标记前提前结束");
  if (!answer.trim()) throw modelStreamError("模型完成后没有返回正文");
  return { answer: answer.trim(), taskId, messageId, conversationId, usage, points, finishEvent };
}

module.exports = { consumeModelEventStream, createModelRequestPayload, normalizeModelPoints };
