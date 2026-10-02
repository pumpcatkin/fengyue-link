import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { consumeModelEventStream, createModelRequestPayload, normalizeModelPoints } = require("../electron/model-stream.cjs");
const encoder = new TextEncoder();

describe("online world model event stream", () => {
  it("sends validated uploaded files and rejects arbitrary remote or credential-bearing attachments", () => {
    const file = { type: "document", transfer_method: "local_file", upload_file_id: "file-123" };
    expect(createModelRequestPayload({ workId: "work", query: "read", files: [file] }).files).toEqual([file]);
    expect(() => createModelRequestPayload({ files: [{ type: "document", transfer_method: "remote_url", url: "file:///private" }] })).toThrow();
    expect(() => createModelRequestPayload({ files: Array(4).fill(file) })).toThrow();
  });
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

  it("keeps platform point accounting separate from token usage", async () => {
    expect(normalizeModelPoints({ prompt_tokens: 99, total_tokens: 120 })).toBeNull();
    expect(normalizeModelPoints({ input_points: 2.5, output_points: "7.5" })).toEqual({ input: 2.5, output: 7.5, total: 10, source: "model-response" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"完成","conversation_id":"points-session"}\n\ndata: {"event":"message_end","metadata":{"usage":{"prompt_tokens":10,"prompt_points":3,"completion_points":6,"total_points":9}}}\n\n'));
      }
    });
    await expect(consumeModelEventStream(stream)).resolves.toMatchObject({
      answer: "完成",
      conversationId: "points-session",
      points: { input: 3, output: 6, total: 9, source: "model-response" }
    });
  });

  it("preserves point usage observed before a stream error or premature close", async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"部分","metadata":{"usage":{"input_points":2,"output_points":3,"total_points":5}}}\n\ndata: {"event":"error","message":"平台中断"}\n\n'));
      }
    });
    let streamError: any;
    try { await consumeModelEventStream(errorStream); } catch (error) { streamError = error; }
    expect(streamError).toMatchObject({
      message: "平台中断",
      points: { input: 2, output: 3, total: 5, source: "model-response" }
    });

    const closedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"event":"message","answer":"半截","usage":{"input_points":4,"output_points":1,"total_points":5}}\n\n'));
        controller.close();
      }
    });
    let closeError: any;
    try { await consumeModelEventStream(closedStream); } catch (error) { closeError = error; }
    expect(closeError).toMatchObject({
      message: expect.stringMatching(/完成标记前提前结束/),
      points: { input: 4, output: 1, total: 5, source: "model-response" }
    });
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
