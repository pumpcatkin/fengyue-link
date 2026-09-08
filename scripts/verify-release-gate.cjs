const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LATEST_MANIFEST_URL,
  LATEST_SIGNATURE_URL,
  ReleaseSecurityGate,
} = require("../electron/release-security.cjs");

const projectRoot = path.resolve(__dirname, "..");
const releaseRoot = path.join(projectRoot, "release");
const manifestBytes = fs.readFileSync(path.join(releaseRoot, "github", "release-manifest.json"));
const signatureBytes = fs.readFileSync(path.join(releaseRoot, "github", "release-manifest.sig"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fengyue-release-gate-"));
const resourcesPath = path.join(temporaryRoot, "resources");
const executablePath = path.join(temporaryRoot, "风月联机工具.exe");
const userDataPath = path.join(temporaryRoot, "user-data");

fs.mkdirSync(resourcesPath, { recursive: true });
fs.copyFileSync(path.join(releaseRoot, "win-unpacked", "resources", "app.asar"), path.join(resourcesPath, "app.asar"));
fs.copyFileSync(path.join(releaseRoot, "win-unpacked", "风月联机工具.exe"), executablePath);

const response = (body, contentType) => new Response(body, {
  status: 200,
  headers: { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) }
});
const onlineNet = {
  requests: 0,
  async fetch(url) {
    this.requests += 1;
    if (url === LATEST_MANIFEST_URL) return response(manifestBytes, "application/octet-stream");
    if (url === LATEST_SIGNATURE_URL) return response(signatureBytes, "application/octet-stream");
    return new Response("not found", { status: 404 });
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
    const onlineGate = new ReleaseSecurityGate({ ...gateOptions, net: onlineNet });
    const onlineState = await onlineGate.ensureVerified();
    assert.equal(onlineState.status, "verified");
    assert.equal(onlineState.source, "first-run-github-signed-manifest");
    assert.equal(onlineNet.requests, 2);

    const offlineGate = new ReleaseSecurityGate({
      ...gateOptions,
      net: { fetch: async () => { throw new Error("完成记录存在时不应再次访问网络"); } }
    });
    const cachedState = await offlineGate.initialize();
    assert.equal(cachedState.status, "verified");
    assert.equal(cachedState.source, "first-run-record");

    fs.appendFileSync(path.join(resourcesPath, "app.asar"), Buffer.from([0]));
    const recordedGate = new ReleaseSecurityGate({
      ...gateOptions,
      net: { fetch: async () => { throw new Error("后续启动不得重新联网"); } }
    });
    const recordedState = await recordedGate.initialize();
    assert.equal(recordedState.status, "verified");
    assert.equal(recordedState.source, "first-run-record");

    const tamperUserDataPath = path.join(temporaryRoot, "tamper-first-run-user-data");
    const tamperedGate = new ReleaseSecurityGate({ ...gateOptions, userDataPath: tamperUserDataPath, net: onlineNet });
    const tamperedState = await tamperedGate.initialize();
    assert.equal(tamperedState.status, "blocked");
    assert.equal(tamperedState.errorCode, "artifact-mismatch");

    const repeatedTamperedGate = new ReleaseSecurityGate({
      ...gateOptions,
      userDataPath: tamperUserDataPath,
      net: { fetch: async () => { throw new Error("失败结果存在时不应再次访问网络"); } }
    });
    const repeatedTamperedState = await repeatedTamperedGate.initialize();
    assert.equal(repeatedTamperedState.status, "blocked");
    assert.equal(repeatedTamperedState.source, "first-run-record");

    process.stdout.write("安装版安全门端到端验证通过：首次启动自动验证、完成记录复用、首次篡改阻断且后续不重复联网。\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
