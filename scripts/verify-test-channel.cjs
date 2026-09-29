const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageJson = require("../package.json");
const {
  ReleaseSecurityGate,
  RUNTIME_PROOF_DIRECTORY,
  RUNTIME_PROOF_MANIFEST_ASSET
} = require("../electron/release-security.cjs");

if (packageJson.fengyueReleaseChannel !== "test") {
  throw new Error("当前 package.json 不是测试渠道，拒绝执行测试渠道验证");
}

const projectRoot = path.resolve(__dirname, "..");
const releaseRoot = path.join(projectRoot, "release");
const runtimeRoot = path.resolve(projectRoot, process.argv.find(arg => arg.startsWith("--runtime="))?.slice(10) || path.join(releaseRoot, "win-unpacked"));
const runtimeProofRoot = path.join(runtimeRoot, "resources", RUNTIME_PROOF_DIRECTORY);
const manifestPath = path.join(runtimeProofRoot, RUNTIME_PROOF_MANIFEST_ASSET);
if (!fs.existsSync(manifestPath)) {
  throw new Error(`缺少测试运行清单，请先运行 npm run pack:dir：${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fengyue-test-channel-"));
const resourcesPath = path.join(temporaryRoot, "resources");
const executablePath = path.join(temporaryRoot, "风月联机工具.exe");
const userDataPath = path.join(temporaryRoot, "user-data");
const offlineNet = {
  requests: 0,
  async fetch() {
    this.requests += 1;
    throw new Error("测试渠道不应访问 GitHub");
  }
};

fs.mkdirSync(resourcesPath, { recursive: true });
fs.copyFileSync(path.join(runtimeRoot, "resources", "app.asar"), path.join(resourcesPath, "app.asar"));
fs.copyFileSync(path.join(runtimeRoot, "风月联机工具.exe"), executablePath);
fs.cpSync(runtimeProofRoot, path.join(resourcesPath, RUNTIME_PROOF_DIRECTORY), { recursive: true });

const gateOptions = {
  appVersion: manifest.version,
  isPackaged: true,
  testMode: true,
  resourcesPath,
  executablePath,
  userDataPath
};

(async () => {
  try {
    const cleanGate = new ReleaseSecurityGate({ ...gateOptions, net: offlineNet });
    const cleanState = await cleanGate.ensureVerified();
    assert.deepEqual(
      {
        status: cleanState.status,
        source: cleanState.source,
        channel: cleanState.channel,
        verifiedFileCount: cleanState.verifiedFileCount
      },
      {
        status: "verified",
        source: "test-channel-local-manifest",
        channel: "test",
        verifiedFileCount: 2
      }
    );
    assert.equal(offlineNet.requests, 0);

    fs.appendFileSync(path.join(resourcesPath, "app.asar"), Buffer.from([0]));
    const tamperedGate = new ReleaseSecurityGate({ ...gateOptions, net: offlineNet });
    const tamperedState = await tamperedGate.initialize();
    assert.deepEqual(
      {
        status: tamperedState.status,
        verified: tamperedState.verified,
        errorCode: tamperedState.errorCode
      },
      {
        status: "warning",
        verified: false,
        errorCode: "artifact-mismatch"
      }
    );
    assert.equal(offlineNet.requests, 0);

    process.stdout.write(`测试分支本地校验通过：版本号保持 ${packageJson.version}；自动更新渠道已关闭。\n`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
