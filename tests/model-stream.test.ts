import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { consumeModelEventStream, createModelRequestPayload } = require("../electron/model-stream.cjs");
const encoder = new TextEncoder();

describe("online world model event stream", () => {
  it("always omits the conversation id so every platform request creates a new session", () => {
    expect(createModelRequestPayload({ workId: "work", conversationId: "", query: "hello" })).toEqual({
      app_id: "work", inputs: {}, query: "hello", response_mode: "streaming", files: []
    });
    expect(createModelRequestPayload({ workId: "work", conversationId: "conversation-1", query: "next" })).toEqual({
      app_id: "work", inputs: {}, query: "next", response_mode: "streaming", files: []
    });
  });

  it("waits for an explicit completion event before returning the accumulated answer", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    let settled = false;
    const pending = consumeModelEventStream(stream).finally(() => { settled = true; });
    controller!.enqueue(encoder.encode('data: {"event":"message","answer":"前半","conversation_id":"c1"}\n\n'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    controller!.enqueue(encoder.encode('data: {"event":"message","answer":"后半","message_id":"m1"}\n\ndata: {"event":"message_end","metadata":{"usage":{"total_tokens":12}}}\n\n'));
    const result = await pending;
    expect(result).toMatchObject({ answer: "前半后半", conversationId: "c1", messageId: "m1", finishEvent: "message_end", usage: { total_tokens: 12 } });
  });

  it("supports replacement output and workflow completion", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"草稿"}\r\n\r\ndata: {"event":"message_replace","answer":"最终 JSON"}\r\n\r\ndata: {"event":"workflow_finished"}\r\n\r\n'));
      }
    });
    await expect(consumeModelEventStream(stream)).resolves.toMatchObject({ answer: "最终 JSON", finishEvent: "workflow_finished" });
  });

  it("ignores plain-text stream heartbeat events during a long generation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"前半"}\n\ndata: ping\n\ndata: {"event":"message","answer":"后半","conversation_id":"c-heartbeat"}\n\ndata: {"event":"message_end"}\n\n'));
      }
    });
    await expect(consumeModelEventStream(stream)).resolves.toMatchObject({ answer: "前半后半", conversationId: "c-heartbeat", finishEvent: "message_end" });
  });

  it("accepts the protocol DONE sentinel as completion", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"完成"}\n\ndata: [DONE]\n\n'));
      }
    });
    await expect(consumeModelEventStream(stream)).resolves.toMatchObject({ answer: "完成", finishEvent: "done" });
  });

  it("rejects a connection that closes before a completion marker", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"半截内容"}\n\n'));
        controller.close();
      }
    });
    await expect(consumeModelEventStream(stream)).rejects.toThrow(/完成标记前提前结束/);
  });
});
