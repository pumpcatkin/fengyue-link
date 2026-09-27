const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const {
  OFFICIAL_RELEASE_PAGE,
  RUNTIME_PROOF_DIRECTORY,
  RUNTIME_PROOF_MANIFEST_ASSET,
  exactReleasePage,
  sha256File,
  validateManifestForRuntime
} = require("../electron/release-security.cjs");

if (packageJson.fengyueReleaseChannel !== "test") {
  throw new Error("当前 package.json 不是测试渠道，拒绝生成测试运行清单");
}

const projectRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(projectRoot, "release", "win-unpacked");
const resourcesPath = path.join(runtimeRoot, "resources");
const outputDirectory = path.join(resourcesPath, RUNTIME_PROOF_DIRECTORY);
const appAsarPath = path.join(resourcesPath, "app.asar");
const executableName = "风月联机工具.exe";
const executablePath = path.join(runtimeRoot, executableName);

for (const file of [appAsarPath, executablePath]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`缺少测试包文件：${file}`);
  }
}

const tag = `v${packageJson.version}`;
const appAsarStat = fs.statSync(appAsarPath);
const executableStat = fs.statSync(executablePath);
const manifest = {
  schemaVersion: 1,
  product: "fengyue-link",
  appId: packageJson.build.appId,
  version: packageJson.version,
  tag,
  channel: "test",
  officialReleasePage: OFFICIAL_RELEASE_PAGE,
  releasePage: exactReleasePage(tag),
  publishedAt: new Date().toISOString(),
  files: {
    appAsar: {
      path: "resources/app.asar",
      size: appAsarStat.size,
      sha256: sha256File(appAsarPath)
    },
    executable: {
      name: executableName,
      size: executableStat.size,
      sha256: sha256File(executablePath)
    }
  }
};

validateManifestForRuntime(manifest);
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, RUNTIME_PROOF_MANIFEST_ASSET), manifestBytes, { mode: 0o644 });

process.stdout.write([
  `已生成测试渠道 v${packageJson.version} 本地运行清单。`,
  `目录：${outputDirectory}`,
  `主程序 SHA-256：${manifest.files.executable.sha256}`,
  `app.asar SHA-256：${manifest.files.appAsar.sha256}`,
  "自动更新：已关闭"
].join("\n") + "\n");
