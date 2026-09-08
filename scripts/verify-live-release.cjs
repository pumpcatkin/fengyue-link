const { app, net } = require("electron");
const packageJson = require("../package.json");
const { ReleaseSecurityGate } = require("../electron/release-security.cjs");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const expectedVersion = String(argument("version") || packageJson.version);

app.whenReady().then(async () => {
  try {
    const gate = new ReleaseSecurityGate({
      net,
      appVersion: expectedVersion,
      isPackaged: false,
      resourcesPath: "",
      executablePath: "",
      userDataPath: ""
    });
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
