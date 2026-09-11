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
    assert.equal(onlineState.source, "startup-github-signed-manifest");
    assert.equal(onlineState.verifiedFileCount, 2);
    assert.equal(onlineNet.requests, 2);
    assert.equal(fs.existsSync(path.join(userDataPath, "release-security")), false);

    const repeatedOnlineGate = new ReleaseSecurityGate({
      ...gateOptions,
      net: onlineNet
    });
    const repeatedState = await repeatedOnlineGate.initialize();
    assert.equal(repeatedState.status, "verified");
    assert.equal(repeatedState.source, "startup-github-signed-manifest");
    assert.equal(onlineNet.requests, 4);

    fs.appendFileSync(path.join(resourcesPath, "app.asar"), Buffer.from([0]));
    const tamperedGate = new ReleaseSecurityGate({
      ...gateOptions,
      net: onlineNet
    });
    const tamperedState = await tamperedGate.initialize();
    assert.equal(tamperedState.status, "blocked");
    assert.equal(tamperedState.errorCode, "artifact-mismatch");
    assert.equal(onlineNet.requests, 6);

    fs.copyFileSync(path.join(releaseRoot, "win-unpacked", "resources", "app.asar"), path.join(resourcesPath, "app.asar"));
    fs.appendFileSync(executablePath, Buffer.from([0]));
    const executableTamperedGate = new ReleaseSecurityGate({ ...gateOptions, net: onlineNet });
    const executableTamperedState = await executableTamperedGate.initialize();
    assert.equal(executableTamperedState.status, "blocked");
    assert.equal(executableTamperedState.errorCode, "artifact-mismatch");
    assert.equal(onlineNet.requests, 8);

    process.stdout.write("安装版安全门端到端验证通过：每次启动重新验签并校验 2 个关键文件，篡改 app.asar 或主 EXE 均会被阻断。\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
