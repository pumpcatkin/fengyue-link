"use strict";

const MODEL_TASKS_SCHEMA = "fyow.model-tasks/1";
const MODEL_REQUEST_PROTOCOL = "fyow-host/2";
const MODEL_REQUEST_METHOD = "model.run";
const MODEL_TASK_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MODEL_TASK_CONTEXT_PATTERN = /^(?:input|save)(?:\.[A-Za-z0-9_-]{1,64})*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MODEL_TASKS = 64;
const MAX_MODEL_TASKS_BYTES = 1024 * 1024;
const MAX_TASK_PROMPT_BYTES = 128 * 1024;
const MAX_TASK_SCHEMA_BYTES = 128 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const HARD_MAX_INPUT_BYTES = 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 1024;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_SCHEMA_ALTERNATIVES = 8;
const MAX_SCHEMA_ENUM_VALUES = 256;

const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SCHEMA_KEYS = new Set([
  "title", "description", "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "anyOf", "oneOf"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return true;
  return Object.prototype.toString.call(value) === "[object Object]"
    && Object.getPrototypeOf(prototype) === null;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function normalizeJsonValue(value, path = "value", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} 不能包含非有限数字`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${path} 不能包含循环引用`);
    seen.add(value);
    const result = value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new Error(`${path} 不能包含循环引用`);
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (UNSAFE_OBJECT_KEYS.has(key)) throw new Error(`${path}.${key} 使用了禁止的对象字段名`);
      if (value[key] === undefined) throw new Error(`${path}.${key} 不能是 undefined`);
      result[key] = normalizeJsonValue(value[key], `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error(`${path} 包含 JSON 不支持的值：${typeof value}`);
}

function jsonBytes(value, path = "value") {
  return byteLength(JSON.stringify(normalizeJsonValue(value, path)));
}

function boundedInteger(value, fallback, minimum, maximum, path) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${path} 必须是 ${minimum}–${maximum} 之间的整数`);
  }
  return number;
}

function normalizeSchemaText(value, path, maximum = 2048) {
  if (typeof value !== "string") throw new Error(`${path} 必须是字符串`);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (byteLength(text) > maximum) throw new Error(`${path} 超过 ${maximum} 字节限制`);
  return text;
}

function normalizeSchemaType(value, path) {
  const source = Array.isArray(value) ? value : [value];
  if (!source.length || source.length > JSON_TYPES.size) throw new Error(`${path} 类型列表无效`);
  const types = [...new Set(source.map(item => String(item || "")))];
  if (types.some(type => !JSON_TYPES.has(type))) throw new Error(`${path} 包含不支持的 JSON 类型`);
  return Array.isArray(value) ? types.sort() : types[0];
}

function normalizeNonNegativeInteger(value, path) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > HARD_MAX_INPUT_BYTES) {
    throw new Error(`${path} 必须是 0–${HARD_MAX_INPUT_BYTES} 之间的整数`);
  }
  return number;
}

function normalizeFiniteNumber(value, path) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${path} 必须是有限数字`);
  return number;
}

function normalizeJsonSchema(value, { path = "schema", root = true } = {}, state = null, depth = 0) {
  if (!isPlainObject(value)) throw new Error(`${path} 必须是 JSON Schema 对象`);
  const tracker = state || { nodes: 0 };
  tracker.nodes += 1;
  if (tracker.nodes > MAX_SCHEMA_NODES) throw new Error(`${path} 超过 ${MAX_SCHEMA_NODES} 个 Schema 节点限制`);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${path} 超过 ${MAX_SCHEMA_DEPTH} 层深度限制`);
  const unknown = Object.keys(value).find(key => !SCHEMA_KEYS.has(key));
  if (unknown) throw new Error(`${path}.${unknown} 不是支持的 Schema 关键字`);

  const result = {};
  if (value.title != null) result.title = normalizeSchemaText(value.title, `${path}.title`, 256);
  if (value.description != null) result.description = normalizeSchemaText(value.description, `${path}.description`);
  if (value.type != null) result.type = normalizeSchemaType(value.type, `${path}.type`);
  if (root) {
    const types = Array.isArray(result.type) ? result.type : [result.type];
    if (!types.includes("object")) throw new Error(`${path}.type 必须包含 object`);
  }

  if (value.enum != null) {
    if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > MAX_SCHEMA_ENUM_VALUES) {
      throw new Error(`${path}.enum 必须包含 1–${MAX_SCHEMA_ENUM_VALUES} 个值`);
    }
    result.enum = value.enum.map((item, index) => normalizeJsonValue(item, `${path}.enum[${index}]`));
    const identities = result.enum.map(item => JSON.stringify(item));
    if (new Set(identities).size !== identities.length) throw new Error(`${path}.enum 不能包含重复值`);
  }
  if (Object.hasOwn(value, "const")) result.const = normalizeJsonValue(value.const, `${path}.const`);

  if (value.properties != null) {
    if (!isPlainObject(value.properties)) throw new Error(`${path}.properties 必须是对象`);
    const keys = Object.keys(value.properties).sort();
    if (keys.length > MAX_SCHEMA_PROPERTIES) throw new Error(`${path}.properties 超过 ${MAX_SCHEMA_PROPERTIES} 项限制`);
    result.properties = {};
    for (const key of keys) {
      if (!key || key.length > 128 || /[\u0000-\u001f]/.test(key) || UNSAFE_OBJECT_KEYS.has(key)) {
        throw new Error(`${path}.properties 包含无效字段名`);
      }
      result.properties[key] = normalizeJsonSchema(value.properties[key], { path: `${path}.properties.${key}`, root: false }, tracker, depth + 1);
    }
  }
  if (value.required != null) {
    if (!Array.isArray(value.required) || value.required.length > MAX_SCHEMA_PROPERTIES
      || value.required.some(item => typeof item !== "string" || !item)) throw new Error(`${path}.required 必须是字段名数组`);
    result.required = [...new Set(value.required)].sort();
    if (result.required.length !== value.required.length) throw new Error(`${path}.required 不能包含重复字段`);
    const defined = new Set(Object.keys(result.properties || {}));
    if (result.required.some(key => !defined.has(key))) throw new Error(`${path}.required 包含未在 properties 声明的字段`);
  }
  const types = Array.isArray(result.type) ? result.type : [result.type];
  if (types.includes("object")) {
    result.properties ||= {};
    result.required ||= [];
    if (value.additionalProperties != null && typeof value.additionalProperties !== "boolean") {
      throw new Error(`${path}.additionalProperties 只支持布尔值`);
    }
    result.additionalProperties = value.additionalProperties === true;
  } else if (value.properties != null || value.required != null || value.additionalProperties != null) {
    throw new Error(`${path} 只有 object 类型可以声明 properties、required 或 additionalProperties`);
  }

  if (value.items != null) result.items = normalizeJsonSchema(value.items, { path: `${path}.items`, root: false }, tracker, depth + 1);
  if (types.includes("array") && !result.items) throw new Error(`${path}.items 是 array 类型的必填字段`);
  if (!types.includes("array") && value.items != null) throw new Error(`${path}.items 只能用于 array 类型`);

  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    if (value[key] != null) result[key] = normalizeNonNegativeInteger(value[key], `${path}.${key}`);
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (value[key] != null) result[key] = normalizeFiniteNumber(value[key], `${path}.${key}`);
  }
  if (value.uniqueItems != null) {
    if (typeof value.uniqueItems !== "boolean") throw new Error(`${path}.uniqueItems 必须是布尔值`);
    result.uniqueItems = value.uniqueItems;
  }
  for (const [minimum, maximum] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]]) {
    if (result[minimum] != null && result[maximum] != null && result[minimum] > result[maximum]) {
      throw new Error(`${path}.${minimum} 不能大于 ${maximum}`);
    }
  }
  if (result.minimum != null && result.maximum != null && result.minimum > result.maximum) {
    throw new Error(`${path}.minimum 不能大于 maximum`);
  }

  for (const keyword of ["anyOf", "oneOf"]) {
    if (value[keyword] == null) continue;
    if (!Array.isArray(value[keyword]) || !value[keyword].length || value[keyword].length > MAX_SCHEMA_ALTERNATIVES) {
      throw new Error(`${path}.${keyword} 必须包含 1–${MAX_SCHEMA_ALTERNATIVES} 个分支`);
    }
    result[keyword] = value[keyword].map((item, index) => normalizeJsonSchema(
      item, { path: `${path}.${keyword}[${index}]`, root: false }, tracker, depth + 1
    ));
  }
  return result;
}

function normalizeModelTask(value, index = 0) {
  const path = `modelTasks.tasks[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${path} 必须是对象`);
  const allowed = new Set([
    "taskId", "version", "prompt", "inputSchema", "outputSchema", "context",
    "maxInputBytes", "maxOutputBytes", "billing"
  ]);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} 不是支持的模型任务字段`);
  const taskId = String(value.taskId || "");
  if (!MODEL_TASK_ID_PATTERN.test(taskId) || taskId.length > 96) throw new Error(`${path}.taskId 无效`);
  const version = boundedInteger(value.version, 1, 1, 999, `${path}.version`);
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error(`${path}.prompt 必须是非空字符串`);
  const prompt = value.prompt.replace(/\r\n?/g, "\n").trim();
  if (byteLength(prompt) > MAX_TASK_PROMPT_BYTES) throw new Error(`${path}.prompt 超过 ${MAX_TASK_PROMPT_BYTES} 字节限制`);
  const inputSchema = normalizeJsonSchema(value.inputSchema, { path: `${path}.inputSchema`, root: true });
  const outputSchema = normalizeJsonSchema(value.outputSchema, { path: `${path}.outputSchema`, root: true });
  if (jsonBytes(inputSchema, `${path}.inputSchema`) > MAX_TASK_SCHEMA_BYTES) throw new Error(`${path}.inputSchema 超过大小限制`);
  if (jsonBytes(outputSchema, `${path}.outputSchema`) > MAX_TASK_SCHEMA_BYTES) throw new Error(`${path}.outputSchema 超过大小限制`);
  const maxInputBytes = boundedInteger(value.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 256, HARD_MAX_INPUT_BYTES, `${path}.maxInputBytes`);
  const maxOutputBytes = boundedInteger(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 256, HARD_MAX_OUTPUT_BYTES, `${path}.maxOutputBytes`);
  const context = value.context == null ? ["input"] : value.context;
  if (!Array.isArray(context) || !context.length || context.length > 16
    || context.some(item => typeof item !== "string" || !MODEL_TASK_CONTEXT_PATTERN.test(item))) {
    throw new Error(`${path}.context 只能包含 input 或 save 下的受限字段路径`);
  }
  const normalizedContext = [...new Set(context)].sort();
  if (normalizedContext.length !== context.length) throw new Error(`${path}.context 不能包含重复路径`);
  const billing = value.billing == null ? {} : value.billing;
  if (!isPlainObject(billing) || Object.keys(billing).some(key => !["confirmation", "retryConfirmation"].includes(key))) {
    throw new Error(`${path}.billing 字段无效`);
  }
  const normalizedBilling = {
    confirmation: billing.confirmation == null ? "host" : String(billing.confirmation),
    retryConfirmation: billing.retryConfirmation == null ? "each-attempt" : String(billing.retryConfirmation)
  };
  if (normalizedBilling.confirmation !== "host") throw new Error(`${path}.billing.confirmation 必须是 host`);
  if (normalizedBilling.retryConfirmation !== "each-attempt") throw new Error(`${path}.billing.retryConfirmation 必须是 each-attempt`);
  return {
    taskId, version, prompt, inputSchema, outputSchema, context: normalizedContext,
    maxInputBytes, maxOutputBytes, billing: normalizedBilling
  };
}

function normalizeModelTasks(value) {
  const source = value == null ? { schema: MODEL_TASKS_SCHEMA, tasks: [] }
    : (Array.isArray(value) ? { schema: MODEL_TASKS_SCHEMA, tasks: value } : value);
  if (!isPlainObject(source)) throw new Error("modelTasks 必须是版本化对象或任务数组");
  if (source.schema != null && source.schema !== MODEL_TASKS_SCHEMA) throw new Error("modelTasks 格式版本不受支持");
  const unknown = Object.keys(source).find(key => !["schema", "tasks"].includes(key));
  if (unknown) throw new Error(`modelTasks.${unknown} 不是支持的字段`);
  if (!Array.isArray(source.tasks)) throw new Error("modelTasks.tasks 必须是数组");
  if (source.tasks.length > MAX_MODEL_TASKS) throw new Error(`modelTasks.tasks 超过 ${MAX_MODEL_TASKS} 项限制`);
  const tasks = source.tasks.map(normalizeModelTask).sort((left, right) => left.taskId.localeCompare(right.taskId, "en"));
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.taskId)) throw new Error(`modelTasks.tasks 包含重复 taskId：${task.taskId}`);
    seen.add(task.taskId);
  }
  const manifest = { schema: MODEL_TASKS_SCHEMA, tasks };
  if (jsonBytes(manifest, "modelTasks") > MAX_MODEL_TASKS_BYTES) throw new Error(`modelTasks 超过 ${MAX_MODEL_TASKS_BYTES} 字节限制`);
  return manifest;
}

function validateModelTasks(value) {
  return normalizeModelTasks(value);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function schemaTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function schemaFailure(path, message) {
  throw new Error(`${path} ${message}`);
}

function validateNormalizedSchemaValue(schema, value, path) {
  for (const keyword of ["anyOf", "oneOf"]) {
    if (!schema[keyword]) continue;
    let matches = 0;
    for (const branch of schema[keyword]) {
      try { validateNormalizedSchemaValue(branch, value, path); matches += 1; } catch { /* try the next branch */ }
    }
    if ((keyword === "anyOf" && matches < 1) || (keyword === "oneOf" && matches !== 1)) {
      schemaFailure(path, `不符合 ${keyword} 约束`);
    }
  }
  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => schemaTypeMatches(type, value))) schemaFailure(path, `类型必须是 ${types.join("|")}`);
  }
  if (schema.enum && !schema.enum.some(item => deepEqual(item, value))) schemaFailure(path, "不在允许的枚举中");
  if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, value)) schemaFailure(path, "不等于规定常量");
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength != null && length < schema.minLength) schemaFailure(path, `长度不能小于 ${schema.minLength}`);
    if (schema.maxLength != null && length > schema.maxLength) schemaFailure(path, `长度不能大于 ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) schemaFailure(path, "必须是有限数字");
    if (schema.minimum != null && value < schema.minimum) schemaFailure(path, `不能小于 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) schemaFailure(path, `不能大于 ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) schemaFailure(path, `必须大于 ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) schemaFailure(path, `必须小于 ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) schemaFailure(path, `条目数不能小于 ${schema.minItems}`);
    if (schema.maxItems != null && value.length > schema.maxItems) schemaFailure(path, `条目数不能大于 ${schema.maxItems}`);
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some(previous => deepEqual(previous, item)))) {
      schemaFailure(path, "不能包含重复条目");
    }
    if (schema.items) value.forEach((item, index) => validateNormalizedSchemaValue(schema.items, item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties != null && keys.length < schema.minProperties) schemaFailure(path, `字段数不能小于 ${schema.minProperties}`);
    if (schema.maxProperties != null && keys.length > schema.maxProperties) schemaFailure(path, `字段数不能大于 ${schema.maxProperties}`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) schemaFailure(`${path}.${key}`, "是必填字段");
    for (const key of keys) {
      if (schema.properties?.[key]) validateNormalizedSchemaValue(schema.properties[key], value[key], `${path}.${key}`);
      else if (schema.additionalProperties !== true) schemaFailure(`${path}.${key}`, "不是允许的字段");
    }
  }
  return value;
}

function validateJsonSchemaValue(schema, value, { label = "value", normalized = false } = {}) {
  const checkedSchema = normalized ? schema : normalizeJsonSchema(schema, { path: `${label}Schema`, root: false });
  const checkedValue = normalizeJsonValue(value, label);
  validateNormalizedSchemaValue(checkedSchema, checkedValue, label);
  return checkedValue;
}

function resolveModelTask(modelTasks, taskId) {
  const manifest = normalizeModelTasks(modelTasks);
  const id = String(taskId || "");
  const task = manifest.tasks.find(item => item.taskId === id);
  if (!task) throw new Error(`未登记的模型任务：${id || "空"}`);
  return task;
}

function validateModelTaskInput(task, input) {
  const normalizedTask = normalizeModelTask(task, 0);
  const checked = validateJsonSchemaValue(normalizedTask.inputSchema, input, { label: "input", normalized: true });
  const bytes = jsonBytes(checked, "input");
  if (bytes > normalizedTask.maxInputBytes) throw new Error(`input 超过任务 ${normalizedTask.taskId} 的 ${normalizedTask.maxInputBytes} 字节限制`);
  return checked;
}

function validateModelTaskOutput(task, output) {
  const normalizedTask = normalizeModelTask(task, 0);
  const checked = validateJsonSchemaValue(normalizedTask.outputSchema, output, { label: "output", normalized: true });
  const bytes = jsonBytes(checked, "output");
  if (bytes > normalizedTask.maxOutputBytes) throw new Error(`output 超过任务 ${normalizedTask.taskId} 的 ${normalizedTask.maxOutputBytes} 字节限制`);
  return checked;
}

function parseModelTaskOutput(task, value) {
  if (typeof value !== "string") return validateModelTaskOutput(task, value);
  const normalizedTask = normalizeModelTask(task, 0);
  if (byteLength(value) > normalizedTask.maxOutputBytes) {
    throw new Error(`output 超过任务 ${normalizedTask.taskId} 的 ${normalizedTask.maxOutputBytes} 字节限制`);
  }
  const text = value.trim();
  const fenced = text.match(/^```json\s*\n([\s\S]*?)\n```$/i);
  const json = fenced ? fenced[1].trim() : text;
  if (!fenced && /^```/.test(text)) throw new Error("output 必须是单个 JSON 对象或单个 json 代码块");
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error("output 不是有效 JSON"); }
  if (!isPlainObject(parsed)) throw new Error("output 顶层必须是 JSON 对象");
  return validateModelTaskOutput(normalizedTask, parsed);
}

function assertIdentifier(value, path, { uuid = false, maximum = 160 } = {}) {
  const text = String(value || "");
  if (uuid ? !UUID_PATTERN.test(text) : (!text || text.length > maximum || /[\u0000-\u001f]/.test(text))) {
    throw new Error(`${path} 无效`);
  }
  return text;
}

function buildModelTaskRequest(modelTasks, { sessionId, requestId, taskId, input, idempotencyKey } = {}) {
  const task = resolveModelTask(modelTasks, taskId);
  const checkedInput = validateModelTaskInput(task, input);
  return {
    protocol: MODEL_REQUEST_PROTOCOL,
    kind: "request",
    sessionId: assertIdentifier(sessionId, "sessionId"),
    requestId: assertIdentifier(requestId, "requestId", { uuid: true }),
    method: MODEL_REQUEST_METHOD,
    params: {
      taskId: task.taskId,
      taskVersion: task.version,
      idempotencyKey: assertIdentifier(idempotencyKey, "idempotencyKey", { uuid: true }),
      input: checkedInput
    }
  };
}

function buildModelTaskInvocation(modelTasks, { taskId, input, idempotencyKey } = {}) {
  const task = resolveModelTask(modelTasks, taskId);
  const checkedInput = validateModelTaskInput(task, input);
  const operationId = assertIdentifier(idempotencyKey, "idempotencyKey", { uuid: true });
  return {
    schema: "fyow.model-invocation/1",
    taskId: task.taskId,
    taskVersion: task.version,
    idempotencyKey: operationId,
    prompt: task.prompt,
    message: `[[FYOW:TASK:${task.taskId}:v${task.version}]]\n${JSON.stringify(checkedInput)}`,
    input: checkedInput,
    outputSchema: task.outputSchema,
    maxOutputBytes: task.maxOutputBytes,
    billing: task.billing
  };
}

module.exports = {
  MODEL_TASKS_SCHEMA,
  MODEL_REQUEST_PROTOCOL,
  MODEL_REQUEST_METHOD,
  MODEL_TASK_ID_PATTERN,
  MAX_MODEL_TASKS,
  MAX_MODEL_TASKS_BYTES,
  MAX_TASK_PROMPT_BYTES,
  MAX_TASK_SCHEMA_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  HARD_MAX_INPUT_BYTES,
  HARD_MAX_OUTPUT_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  normalizeJsonSchema,
  normalizeModelTask,
  normalizeModelTasks,
  validateModelTasks,
  validateJsonSchemaValue,
  resolveModelTask,
  validateModelTaskInput,
  validateModelTaskOutput,
  parseModelTaskOutput,
  buildModelTaskRequest,
  buildModelTaskInvocation
};
