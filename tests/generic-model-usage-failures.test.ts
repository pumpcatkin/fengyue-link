import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createBlankEditorProject } = require("../electron/online-game-editor.cjs");
const { createGameCardFromEditorProject } = require("../electron/online-world-card.cjs");
const { OnlineWorldService } = require("../electron/online-world-service.cjs");

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

function fixture(requestModel: (request: any) => Promise<any>) {
  const directory = mkdtempSync(join(tmpdir(), "fyow-model-usage-"));
  directories.push(directory);
  const author = "c6ca1964-4444-4444-8444-22b487001450";
  const guest = "c6ca1964-3333-4333-8333-22b487001450";
  const workId = "c6ca1964-1111-4111-8111-22b487001450";
  const project = createBlankEditorProject({ origin: "https://acepro.store", accountId: author });
  project.configuration.model_tasks = {
    schema: "fyow.model-tasks/1",
    tasks: [{
      taskId: "story.generate",
      version: 1,
      prompt: "根据选择生成下一段剧情，只返回 JSON。",
      inputSchema: {
        type: "object",
        properties: { choice: { type: "string", minLength: 1 } },
        required: ["choice"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"],
        additionalProperties: false
      }
    }]
  };
  const card = createGameCardFromEditorProject(project, { origin: "https://acepro.store", authorAccountId: author, workId });
  const detail = { id: workId, name: "模型剧情", author: { id: author }, description: card.companion.configuration.app.description };
  const service = new OnlineWorldService({
    cacheFile: join(directory, "cache.json"),
    getAccount: () => ({ accountId: guest }),
    getOrigin: () => "https://acepro.store",
    requestConsole: async () => detail,
    requestGo: async () => detail,
    requestModel
  });
  service.calibrateClock = async () => {};
  const request = {
    workId,
    gameId: card.gameId,
    taskId: "story.generate",
    input: { choice: "进入森林" },
    idempotencyKey: crypto.randomUUID()
  };
  return { service, card, request };
}

describe("generic game model point usage", () => {
  it("returns the complete successful point breakdown and parses grouped balances", async () => {
    const requestModel = vi.fn(async () => ({
      conversationId: crypto.randomUUID(),
      answer: '{"text":"你踏入了发光的森林。"}',
      points: { input: 2, output: 3, total: 5, source: "model-response" },
      remainingPoints: "1,234"
    }));
    const { service, card, request } = fixture(requestModel);
    await service.open({ card });
    await expect(service.runStandaloneModelTask(request)).resolves.toMatchObject({
      output: { text: "你踏入了发光的森林。" },
      usage: { input: 2, output: 3, total: 5, source: "model-response", remainingPoints: 1234 }
    });
  });

  it("returns and replays charged usage when structured output validation fails", async () => {
    const requestModel = vi.fn(async () => ({
      conversationId: crypto.randomUUID(),
      answer: '{"unexpected":"已产生积分的无效输出"}',
      points: { input: 4, output: 6, total: 10, source: "model-response" },
      remainingPoints: "1,230"
    }));
    const { service, card, request } = fixture(requestModel);
    await service.open({ card });

    let firstError: any;
    try { await service.runStandaloneModelTask(request); } catch (error) { firstError = error; }
    expect(firstError).toMatchObject({
      errorCode: "MODEL_STORY_GENERATE_001",
      usage: { input: 4, output: 6, total: 10, source: "model-response", remainingPoints: 1230 }
    });
    expect(service.state().modelUsageEvents.at(-1)).toMatchObject({
      task: "story.generate",
      status: "failed",
      points: { input: 4, output: 6, total: 10, source: "model-response" },
      remainingPoints: "1,230"
    });

    let replayError: any;
    try { await service.runStandaloneModelTask(request); } catch (error) { replayError = error; }
    expect(replayError).toMatchObject({
      operationId: firstError.operationId,
      retryable: firstError.retryable,
      usage: firstError.usage
    });
    expect(requestModel).toHaveBeenCalledOnce();

    await service.pause();
    await service.open({ card });
    let restoredError: any;
    try { await service.runStandaloneModelTask(request); } catch (error) { restoredError = error; }
    expect(restoredError).toMatchObject({ operationId: firstError.operationId, usage: firstError.usage });
    expect(requestModel).toHaveBeenCalledOnce();
  });
});
