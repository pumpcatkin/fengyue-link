"use strict";
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { testGameInBrowser } = require("../electron/game-harness-browser.cjs");
const file = process.argv.find(a => a.startsWith("--file="))?.slice(7);
const key = process.argv.find(a => a.startsWith("--key="))?.slice(6);
const output = path.join(__dirname, "../output/harness-diagnosis");
app.setPath("userData", path.join(output, "profile"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  try {
    if (!file || !key) throw new Error("需要 --file=项目文件 与 --key=项目编号");
    const project = JSON.parse(fs.readFileSync(file, "utf8")).projects[key];
    const candidate = project?.harnessCandidate;
    if (!candidate?.files) throw new Error("未找到待诊断的候选项目");
    const result = await testGameInBrowser(candidate.files["program.html"], JSON.parse(candidate.files["tests.json"]));
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, errors: result.errors, phase: result.phase, step: result.step, scenarios: result.scenarios?.map(s => s.name) }));
    app.exit(0);
  } catch (error) { console.error(String(error?.message || error)); app.exit(1); }
});
