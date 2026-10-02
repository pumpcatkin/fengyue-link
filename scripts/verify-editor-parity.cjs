"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createBlankEditorProject } = require("../electron/online-game-editor.cjs");
const { createGameCardFromEditorProject, validateGameCard } = require("../electron/online-world-card.cjs");
const {
  assertGridParityProject,
  instantiateGridParityProject,
  smokeGridParityRules
} = require("../electron/editor-grid-parity.cjs");

const root = path.join(__dirname, "..");
const origin = "https://staging.aiero.cc";
const accountId = "39404f0e-7678-45a1-86c6-9a21116bacbd";
const draft = createBlankEditorProject({ origin, accountId });
const identity = { libraryId: `draft::${draft.draftId}`, origin, accountId };
const project = instantiateGridParityProject(
  draft,
  "仅凭纯提示词创建一个功能与猎艳疆土完全一致的新游戏，名为「等价能力验收」",
  identity
);
const parity = assertGridParityProject(project, identity);
const smoke = smokeGridParityRules();
validateGameCard(createGameCardFromEditorProject(project, {
  origin,
  authorAccountId: accountId,
  workId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
}));

console.log(JSON.stringify({
  promptCreation: true,
  packaged: true,
  rulesSmoke: smoke,
  capabilityGroups: parity.capabilities.map(item => ({ name: item.name, passed: item.passed })),
  sourceProof: parity.sourceProof,
  programDigest: parity.programDigest
}, null, 2));

const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const suites = [
  "tests/editor-grid-parity.test.ts",
  "tests/grid-world-game.test.ts",
  "tests/online-world-protocol.test.ts",
  "tests/online-world-card.test.ts",
  "tests/online-world-service.test.ts",
  "tests/online-world-migration-regression.test.ts"
];
const result = spawnSync(process.execPath, [vitest, "run", ...suites, "--exclude", "tmp/**"], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});
if (result.error) throw result.error;
process.exitCode = result.status == null ? 1 : result.status;
