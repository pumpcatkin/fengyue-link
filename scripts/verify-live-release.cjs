const { app, net } = require("electron");
const path = require("node:path");
const packageJson = require("../package.json");
const { ReleaseSecurityGate } = require("../electron/release-security.cjs");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const expectedVersion = String(argument("version") || packageJson.version);
const runtimeRoot = argument("runtime") ? path.resolve(argument("runtime")) : null;

app.whenReady().then(async () => {
  try {
    const gate = new ReleaseSecurityGate({
      net,
      appVersion: expectedVersion,
      isPackaged: Boolean(runtimeRoot),
      resourcesPath: runtimeRoot ? path.join(runtimeRoot, "resources") : "",
      executablePath: runtimeRoot ? path.join(runtimeRoot, "风月联机工具.exe") : "",
      userDataPath: ""
    });
    if (runtimeRoot) {
      const state = await gate.initialize();
      if (!state.verified) throw new Error(`本地安装版启动核验失败：${state.message}`);
      process.stdout.write([
        `本地安装版 GitHub 启动核验通过：v${state.currentVersion}`,
        `核验文件数：${state.verifiedFileCount}`,
        `来源：${state.source}`,
        `发布页：${state.releasePage}`
      ].join("\n") + "\n");
      return;
    }
    const update = await gate.fetchSignedUpdate(expectedVersion);
    process.stdout.write([
      `GitHub 在线签名版本验证通过：v${update.version}`,
      `安装包：${update.installer.name}`,
      `大小：${update.installer.size}`,
      `SHA-256：${update.installer.sha256}`,
      `发布页：${update.releasePage}`
    ].join("\n") + "\n");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
