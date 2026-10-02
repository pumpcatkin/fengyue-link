import crypto from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const contract = require("../electron/model-task-contract.cjs");

const inputSchema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 4000 },
    tone: { type: "string", enum: ["calm", "warm"] }
  },
  required: ["text"],
  additionalProperties: false
};

const outputSchema = {
  type: "object",
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 6000 },
    command: {
      type: ["null", "object"],
      properties: { type: { type: "string", enum: ["continue"] } },
      required: ["type"],
      additionalProperties: false
    }
  },
  required: ["reply", "command"],
  additionalProperties: false
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "story.reply",
    version: 1,
    prompt: "依据输入和当前游戏设定生成回复。只返回符合输出 Schema 的 JSON 对象。",
    inputSchema,
    outputSchema,
    context: ["input", "save.character"],
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 32 * 1024,
    billing: { confirmation: "host", retryConfirmation: "each-attempt" },
    ...overrides
  };
}

describe("generic model task manifest", () => {
  it("normalizes an empty manifest and a standalone task array", () => {
    expect(contract.normalizeModelTasks()).toEqual({ schema: "fyow.model-tasks/1", tasks: [] });
    const normalized = contract.normalizeModelTasks([task()]);
    expect(normalized).toMatchObject({
      schema: "fyow.model-tasks/1",
      tasks: [{ taskId: "story.reply", version: 1, maxInputBytes: 65536, maxOutputBytes: 32768 }]
    });
  });

  it("creates a deterministic sorted copy without changing author input", () => {
    const source = {
      schema: contract.MODEL_TASKS_SCHEMA,
      tasks: [task({ taskId: "world.event", context: ["save.world", "input"] }), task()]
    };
    const snapshot = structuredClone(source);
    const normalized = contract.validateModelTasks(source);
    expect(normalized.tasks.map((item: any) => item.taskId)).toEqual(["story.reply", "world.event"]);
    expect(normalized.tasks[1].context).toEqual(["input", "save.world"]);
    expect(source).toEqual(snapshot);
  });

  it("accepts ordinary objects from another Realm and still rejects class instances", () => {
    const crossRealmManifest = vm.runInNewContext(`(${JSON.stringify({
      schema: contract.MODEL_TASKS_SCHEMA,
      tasks: [task()]
    })})`);
    expect(contract.normalizeModelTasks(crossRealmManifest).tasks[0].taskId).toBe("story.reply");

    class CustomManifest {
      schema = contract.MODEL_TASKS_SCHEMA;
      tasks = [task()];
    }
    expect(() => contract.normalizeModelTasks(new CustomManifest())).toThrow("版本化对象或任务数组");
  });

  it("fills safe billing, context and byte-limit defaults", () => {
    const normalized = contract.normalizeModelTasks([task({
      context: undefined,
      billing: undefined,
      maxInputBytes: undefined,
      maxOutputBytes: undefined
    })]).tasks[0];
    expect(normalized).toMatchObject({
      context: ["input"],
      maxInputBytes: contract.DEFAULT_MAX_INPUT_BYTES,
      maxOutputBytes: contract.DEFAULT_MAX_OUTPUT_BYTES,
      billing: { confirmation: "host", retryConfirmation: "each-attempt" }
    });
  });

  it("rejects duplicate, malformed and undeclared task fields", () => {
    expect(() => contract.normalizeModelTasks([task(), task()])).toThrow("重复 taskId");
    expect(() => contract.normalizeModelTasks([task({ taskId: "猎艳疆土任务" })])).toThrow("taskId 无效");
    expect(() => contract.normalizeModelTasks([task({ endpoint: "https://example.invalid" })])).toThrow("endpoint");
    expect(() => contract.normalizeModelTasks({ schema: "fyow.model-tasks/9", tasks: [] })).toThrow("版本不受支持");
  });

  it("keeps context and billing inside the host-controlled contract", () => {
    expect(() => contract.normalizeModelTasks([task({ context: ["input", "profile.rawCookie"] })])).toThrow("受限字段路径");
    expect(() => contract.normalizeModelTasks([task({ context: ["input", "input"] })])).toThrow("重复路径");
    expect(() => contract.normalizeModelTasks([task({ billing: { confirmation: "card" } })])).toThrow("必须是 host");
    expect(() => contract.normalizeModelTasks([task({ billing: { retryConfirmation: "once" } })])).toThrow("each-attempt");
  });
});

describe("limited JSON Schema contract", () => {
  it("normalizes strict object schemas and rejects external or executable extensions", () => {
    const normalized = contract.normalizeJsonSchema({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    });
    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties.text).toEqual({ type: "string" });
    expect(() => contract.normalizeJsonSchema({ type: "object", $ref: "https://example.invalid/schema" })).toThrow("$ref");
    expect(() => contract.normalizeJsonSchema({ type: "object", patternProperties: { ".*": {} } })).toThrow("patternProperties");
  });

  it("rejects unbounded combinator fan-out and excessive nesting", () => {
    expect(() => contract.normalizeJsonSchema({
      type: "object",
      anyOf: Array.from({ length: contract.MAX_SCHEMA_ALTERNATIVES + 1 }, () => ({ type: "object" }))
    })).toThrow("anyOf");
    let nested: any = { type: "string" };
    for (let index = 0; index < contract.MAX_SCHEMA_DEPTH + 2; index += 1) {
      nested = { type: "array", items: nested };
    }
    expect(() => contract.normalizeJsonSchema({ type: "object", properties: { nested } })).toThrow("深度限制");
  });

  it("validates required fields, enums, ranges, arrays and additional properties", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["event"] },
        score: { type: "integer", minimum: 0, maximum: 10 },
        tags: { type: "array", items: { type: "string", maxLength: 8 }, maxItems: 2, uniqueItems: true }
      },
      required: ["kind", "score", "tags"],
      additionalProperties: false
    };
    expect(contract.validateJsonSchemaValue(schema, { kind: "event", score: 8, tags: ["a", "b"] })).toEqual({ kind: "event", score: 8, tags: ["a", "b"] });
    expect(() => contract.validateJsonSchemaValue(schema, { kind: "event", score: 11, tags: [] })).toThrow("不能大于 10");
    expect(() => contract.validateJsonSchemaValue(schema, { kind: "event", score: 1, tags: ["a", "a"] })).toThrow("重复条目");
    expect(() => contract.validateJsonSchemaValue(schema, { kind: "event", score: 1, tags: [], secret: true })).toThrow("secret");
  });

  it("rejects prototype-mutating property names in schemas and request data", () => {
    const unsafeSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
    const unsafeValue = JSON.parse('{"__proto__":"changed"}');
    expect(() => contract.normalizeJsonSchema(unsafeSchema)).toThrow("无效字段名");
    expect(() => contract.validateJsonSchemaValue({ type: "object", additionalProperties: true }, unsafeValue)).toThrow("禁止的对象字段名");
    expect(({} as any).changed).toBeUndefined();
  });

  it("supports nullable object fields used by structured game commands", () => {
    const normalized = contract.normalizeModelTasks([task()]).tasks[0];
    expect(contract.validateModelTaskOutput(normalized, { reply: "继续前进。", command: null })).toEqual({ command: null, reply: "继续前进。" });
    expect(contract.validateModelTaskOutput(normalized, { reply: "继续前进。", command: { type: "continue" } })).toEqual({ command: { type: "continue" }, reply: "继续前进。" });
  });
});

describe("controlled model requests", () => {
  it("builds fyow-host/2 model.run requests from registered tasks only", () => {
    const manifest = contract.normalizeModelTasks([task()]);
    const requestId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const request = contract.buildModelTaskRequest(manifest, {
      sessionId: "host-issued-session",
      requestId,
      taskId: "story.reply",
      idempotencyKey,
      input: { text: "请生成一段开场", tone: "warm" },
      prompt: "调用者不能覆盖登记提示词",
      endpoint: "https://example.invalid"
    });
    expect(request).toEqual({
      protocol: "fyow-host/2",
      kind: "request",
      sessionId: "host-issued-session",
      requestId,
      method: "model.run",
      params: {
        taskId: "story.reply",
        taskVersion: 1,
        idempotencyKey,
        input: { text: "请生成一段开场", tone: "warm" }
      }
    });
    expect(JSON.stringify(request)).not.toContain("example.invalid");
    expect(JSON.stringify(request)).not.toContain("覆盖登记提示词");
  });

  it("creates a trusted invocation from the registered prompt and output schema", () => {
    const manifest = contract.normalizeModelTasks([task()]);
    const idempotencyKey = crypto.randomUUID();
    const invocation = contract.buildModelTaskInvocation(manifest, {
      taskId: "story.reply",
      idempotencyKey,
      input: { text: "雨夜来客" }
    });
    expect(invocation).toMatchObject({
      schema: "fyow.model-invocation/1",
      taskId: "story.reply",
      taskVersion: 1,
      idempotencyKey,
      maxOutputBytes: 32768
    });
    expect(invocation.prompt).toContain("符合输出 Schema");
    expect(invocation.message).toBe('[[FYOW:TASK:story.reply:v1]]\n{"text":"雨夜来客"}');
    expect(invocation.outputSchema).toEqual(manifest.tasks[0].outputSchema);
  });

  it("rejects unknown tasks, invalid identifiers, schema-invalid input and byte overflow", () => {
    const manifest = contract.normalizeModelTasks([task({
      maxInputBytes: 256,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: 1000 } },
        required: ["text"],
        additionalProperties: false
      }
    })]);
    const valid = { sessionId: "session", requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    expect(() => contract.buildModelTaskRequest(manifest, { ...valid, taskId: "missing", input: {} })).toThrow("未登记");
    expect(() => contract.buildModelTaskRequest(manifest, { ...valid, requestId: "not-uuid", taskId: "story.reply", input: { text: "ok" } })).toThrow("requestId");
    expect(() => contract.buildModelTaskRequest(manifest, { ...valid, taskId: "story.reply", input: { text: "" } })).toThrow("长度不能小于");
    expect(() => contract.buildModelTaskRequest(manifest, { ...valid, taskId: "story.reply", input: { text: "汉".repeat(100) } })).toThrow("字节限制");
  });

  it("accepts one JSON object or one json code block and rejects surrounding model prose", () => {
    const normalized = contract.normalizeModelTasks([task()]).tasks[0];
    expect(contract.parseModelTaskOutput(normalized, '{"reply":"收到。","command":null}')).toEqual({ command: null, reply: "收到。" });
    expect(contract.parseModelTaskOutput(normalized, '```json\n{"reply":"收到。","command":null}\n```')).toEqual({ command: null, reply: "收到。" });
    expect(() => contract.parseModelTaskOutput(normalized, '说明如下：\n```json\n{"reply":"收到。","command":null}\n```')).toThrow("有效 JSON");
    expect(() => contract.parseModelTaskOutput(normalized, '{"reply":"收到。","command":null,"html":"<script>"}')).toThrow("html");
  });
});
