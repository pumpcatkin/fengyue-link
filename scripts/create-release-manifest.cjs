const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const {
  OFFICIAL_RELEASE_PAGE,
  RELEASE_KEY_FINGERPRINT,
  RELEASE_MANIFEST_PUBLIC_KEY,
  exactReleasePage,
  sha256File,
  verifyManifestSignature
} = require("../electron/release-security.cjs");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const projectRoot = path.resolve(__dirname, "..");
const releaseRoot = path.join(projectRoot, "release");
const outputDirectory = path.join(releaseRoot, "github");
const keyPath = path.resolve(argument("key") || process.env.FENGYUE_RELEASE_SIGNING_KEY || "");
const appAsarPath = path.join(releaseRoot, "win-unpacked", "resources", "app.asar");
const executableName = "风月联机工具.exe";
const executablePath = path.join(releaseRoot, "win-unpacked", executableName);
const installerName = `fengyue-link-${packageJson.version}-setup.exe`;
const installerPath = path.join(releaseRoot, installerName);

if (!keyPath || !fs.existsSync(keyPath)) {
  throw new Error("请通过 --key=绝对路径 或 FENGYUE_RELEASE_SIGNING_KEY 指定项目目录外的 Ed25519 私钥");
}
const keyRelativeToProject = path.relative(projectRoot, keyPath);
if (!keyRelativeToProject || (!keyRelativeToProject.startsWith("..") && !path.isAbsolute(keyRelativeToProject))) {
  throw new Error("发布私钥必须保存在项目目录之外");
}
for (const file of [appAsarPath, executablePath, installerPath]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少发布文件：${file}`);
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("发布私钥必须是 Ed25519 密钥");
const derivedPublicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).trim();
if (derivedPublicKey !== RELEASE_MANIFEST_PUBLIC_KEY.trim()) {
  throw new Error(`私钥与应用内固定公钥不匹配（预期指纹 ${RELEASE_KEY_FINGERPRINT}）`);
}

const appAsarStat = fs.statSync(appAsarPath);
const executableStat = fs.statSync(executablePath);
const installerStat = fs.statSync(installerPath);
const tag = `v${packageJson.version}`;
const manifest = {
  schemaVersion: 1,
  product: "fengyue-link",
  appId: packageJson.build.appId,
  version: packageJson.version,
  tag,
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
    },
    installer: {
      name: installerName,
      size: installerStat.size,
      sha256: sha256File(installerPath)
    }
  }
};

const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const signature = crypto.sign(null, manifestBytes, privateKey).toString("base64");
verifyManifestSignature(manifestBytes, signature);

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "release-manifest.json"), manifestBytes, { mode: 0o644 });
fs.writeFileSync(path.join(outputDirectory, "release-manifest.sig"), `${signature}\n`, { mode: 0o644 });
fs.writeFileSync(path.join(outputDirectory, "SHA256SUMS.txt"), [
  `${manifest.files.installer.sha256}  ${installerName}`,
  `${manifest.files.executable.sha256}  ${executableName}`,
  `${manifest.files.appAsar.sha256}  app.asar`,
  `${sha256File(path.join(outputDirectory, "release-manifest.json"))}  release-manifest.json`
].join("\n") + "\n", { mode: 0o644 });

process.stdout.write([
  `已生成 v${packageJson.version} 签名发布清单。`,
  `目录：${outputDirectory}`,
  `安装包 SHA-256：${manifest.files.installer.sha256}`,
  `主程序 SHA-256：${manifest.files.executable.sha256}`,
  `app.asar SHA-256：${manifest.files.appAsar.sha256}`,
  `公钥指纹：${RELEASE_KEY_FINGERPRINT}`
].join("\n") + "\n");
