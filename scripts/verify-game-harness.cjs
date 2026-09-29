const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { testGameInBrowser } = require("../electron/game-harness-browser.cjs");
const { createBlankEditorProject } = require("../electron/online-game-editor.cjs");
const output = path.join(__dirname, "../output/harness-qa");
app.setPath("userData", path.join(output, "profile"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  try {
    const p = createBlankEditorProject();
    const result = await testGameInBrowser(p.program.html, p.harness.tests);
    console.log(JSON.stringify(result));
    assert.equal(result.passed, true, JSON.stringify(result.errors));
    const broken = await testGameInBrowser(p.program.html.replace('game.step++;', '/* missing state change */'), p.harness.tests);
    assert.equal(broken.passed, false);
    assert(broken.errors.every(error => typeof error === "string" && error.length > 0));
    assert(broken.step?.selector, "Cross-frame failures must preserve the failing selector");
    const exitingTests = JSON.parse(JSON.stringify(p.harness.tests));
    exitingTests.scenarios[0].steps.splice(2, 0, { action: "click", selector: "#library" }, { action: "reopen" });
    const exitReopen = await testGameInBrowser(p.program.html, exitingTests);
    assert.equal(exitReopen.passed, true, JSON.stringify(exitReopen.errors));
    assert.equal(exitReopen.scenarios[0].libraryReturns, 1);
    const staleTests = JSON.parse(JSON.stringify(exitingTests));
    staleTests.scenarios[0].steps.splice(3, 1);
    const stalePage = await testGameInBrowser(p.program.html, staleTests);
    assert.equal(stalePage.passed, false);
    assert(stalePage.errors.some(error => error.includes("已返回大厅")));
    const exception = await testGameInBrowser(p.program.html.replace('send("ready",', 'throw Error("intentional-runtime-failure");send("ready",'), p.harness.tests);
    assert.equal(exception.passed, false);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ playable: result, broken, exception, exitReopen, stalePage }, null, 2));
    console.log("HARNESS BROWSER QA PASSED");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
