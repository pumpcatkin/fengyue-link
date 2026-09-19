const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReleaseSecurityGate } = require("../electron/release-security.cjs");

const projectRoot = path.resolve(__dirname, "..");
const releaseRoot = path.join(projectRoot, "release");
const runtimeProofRoot = path.join(releaseRoot, "win-unpacked", "resources", "release-proof");
const manifest = JSON.parse(fs.readFileSync(path.join(runtimeProofRoot, "runtime-manifest.json"), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fengyue-release-gate-"));
const resourcesPath = path.join(temporaryRoot, "resources");
const executablePath = path.join(temporaryRoot, "风月联机工具.exe");
const userDataPath = path.join(temporaryRoot, "user-data");

fs.mkdirSync(resourcesPath, { recursive: true });
fs.copyFileSync(path.join(releaseRoot, "win-unpacked", "resources", "app.asar"), path.join(resourcesPath, "app.asar"));
fs.copyFileSync(path.join(releaseRoot, "win-unpacked", "风月联机工具.exe"), executablePath);
fs.cpSync(runtimeProofRoot, path.join(resourcesPath, "release-proof"), { recursive: true });

const offlineNet = {
  requests: 0,
  async fetch() {
    this.requests += 1;
    throw new Error("启动验证不应访问 GitHub");
  }
};

const gateOptions = {
  appVersion: manifest.version,
  isPackaged: true,
  resourcesPath,
  executablePath,
  userDataPath
};

(async () => {
  try {
    const bundledGate = new ReleaseSecurityGate({ ...gateOptions, net: offlineNet });
    const bundledState = await bundledGate.ensureVerified();
    assert.equal(bundledState.status, "verified");
    assert.equal(bundledState.source, "bundled-signed-runtime-proof");
    assert.equal(bundledState.verifiedFileCount, 2);
    assert.equal(offlineNet.requests, 0);
    assert.equal(fs.existsSync(path.join(userDataPath, "release-security")), false);

    const repeatedOnlineGate = new ReleaseSecurityGate({
      ...gateOptions,
      net: offlineNet
    });
    const repeatedState = await repeatedOnlineGate.initialize();
    assert.equal(repeatedState.status, "verified");
    assert.equal(repeatedState.source, "bundled-signed-runtime-proof");
    assert.equal(offlineNet.requests, 0);

    fs.appendFileSync(path.join(resourcesPath, "app.asar"), Buffer.from([0]));
    const tamperedGate = new ReleaseSecurityGate({
      ...gateOptions,
      net: offlineNet
    });
    const tamperedState = await tamperedGate.initialize();
    assert.equal(tamperedState.status, "blocked");
    assert.equal(tamperedState.errorCode, "artifact-mismatch");
    assert.equal(offlineNet.requests, 0);

    fs.copyFileSync(path.join(releaseRoot, "win-unpacked", "resources", "app.asar"), path.join(resourcesPath, "app.asar"));
    fs.appendFileSync(executablePath, Buffer.from([0]));
    const executableTamperedGate = new ReleaseSecurityGate({ ...gateOptions, net: offlineNet });
    const executableTamperedState = await executableTamperedGate.initialize();
    assert.equal(executableTamperedState.status, "blocked");
    assert.equal(executableTamperedState.errorCode, "artifact-mismatch");
    assert.equal(offlineNet.requests, 0);

    process.stdout.write("安装版安全门端到端验证通过：断开 GitHub 后仍会验签并校验 2 个关键文件，篡改 app.asar 或主 EXE 均会被阻断。\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
